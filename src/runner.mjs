import { ensureChrome, connectChrome, getPage } from "./browser/chrome.mjs";
import { sleep } from "./utils/retry.mjs";
import { collectInventory } from "./collectors/teslaInventory.mjs";
import { diffInventory } from "./state/diffInventory.mjs";
import { buildNotifier } from "./notify/notifier.mjs";
import { applyFilters, applyFiltersToUpdated } from "./notify/filter.mjs";
import { summarize, vehicleId } from "./parsers/normalizeVehicle.mjs";
import { log } from "./utils/log.mjs";
import {
  openDb,
  upsertWatch,
  getSeenIds,
  upsertVehicles,
  markRemoved,
  recordEvents,
  recordRun,
} from "./db/database.mjs";

/**
 * Run one full check cycle across all configured watches.
 * Watches are grouped by model — each state is fetched separately but
 * diffed and notified as a single model unit.
 */
export async function runOnce(config) {
  const db = await openDb(config.dbFile);
  const notifier = buildNotifier(config.notify);
  const fbt = config.fbtThreshold ?? null;
  const triggers = config.notify?.triggers ?? ["new_stock", "price_drop"];
  const filterConfig = config.notify?.filters ?? {};

  await ensureChrome(config.chromeDebugUrl);
  const browser = await connectChrome(config.chromeDebugUrl);
  const page = await getPage(browser);

  // Group watches by model so we diff all states together per model
  const byModel = {};
  for (const watch of config.watches) {
    const key = `${watch.model}|${watch.category ?? ""}`;
    if (!byModel[key]) byModel[key] = { watch, stateWatches: [] };
    byModel[key].stateWatches.push(watch);
  }

  const results = [];

  try {
    for (const { watch: modelWatch, stateWatches } of Object.values(byModel)) {
      const modelLabel = `${modelWatch.model.toUpperCase()} (All AU)`;
      log.info(`--- Watch: ${modelLabel} ---`);

      // Use model-level watch entry in DB (no state key) for state tracking
      const watchKey = { model: modelWatch.model, category: modelWatch.category ?? "", label: modelLabel, market: modelWatch.market ?? "en_AU" };
      const watchId = upsertWatch(db, watchKey);
      const seenIds = getSeenIds(db, watchId);

      // Collect from each state, merge results deduplicating by vehicleId
      const vehicleMap = {};
      let anyInventory = false;
      let anyError = false;

      for (const sw of stateWatches) {
        // Random jitter between requests to avoid looking like a bot
        const jitter = 3000 + Math.random() * 7000;
        log.info(`  Waiting ${Math.round(jitter / 1000)}s before fetching ${sw.state}…`);
        await sleep(jitter);
        log.info(`  Fetching ${sw.state}…`);
        try {
          const { vehicles, pageState } = await collectInventory(page, {
            inventoryUrl: sw.inventoryUrl,
            localeBaseUrl: sw.localeBaseUrl,
            waitMs: config.waitMs,
          });
          if (pageState === "inventory" || pageState === "no-stock") anyInventory = true;
          if (pageState === "blocked" || pageState === "locale-select") {
            log.warn(`  ${sw.state}: ${pageState}`);
            continue;
          }
          for (const v of vehicles) {
            const id = vehicleId(v);
            vehicleMap[id] = v;
          }
          log.info(`  ${sw.state}: ${vehicles.length} vehicles`);
        } catch (err) {
          log.error(`  ${sw.state} collect failed: ${err.message}`);
          anyError = true;
        }
      }

      const vehicles = Object.values(vehicleMap);
      const pageState = anyError && !anyInventory ? "error" : vehicles.length > 0 ? "inventory" : "no-stock";

      log.info(`${modelLabel} total: ${vehicles.length} vehicles`);

      if (pageState === "error") {
        recordRun(db, watchId, { status: pageState, vehicleCount: 0, added: 0, removed: 0, updated: 0 });
        results.push({ watch: modelLabel, status: pageState, vehicles: 0, added: 0, removed: 0, updated: 0 });
        continue;
      }

      for (const v of vehicles) v._id = vehicleId(v);

      const { added, removed, updated } = diffInventory(vehicles, seenIds);
      log.info(`Diff — added: ${added.length}, removed: ${removed.length}, updated: ${updated.length}`);

      upsertVehicles(db, watchId, vehicles, vehicleId);
      markRemoved(db, watchId, removed);

      const notifyAdded = triggers.includes("new_stock") ? applyFilters(added, filterConfig, fbt) : [];
      const notifyUpdated = triggers.includes("price_drop") ? applyFiltersToUpdated(updated, filterConfig, fbt) : [];
      const notified = notifyAdded.length > 0 || notifyUpdated.length > 0;

      recordEvents(db, watchId, { added, removed, updated }, notified);

      if (notifyAdded.length > 0) {
        const itemLines = notifyAdded.map((v) => summarize(v, fbt));
        await notifier.send({
          title: `New Tesla stock (${modelLabel}): ${notifyAdded.length} vehicle${notifyAdded.length > 1 ? "s" : ""}`,
          body: stateWatches[0].inventoryUrl,
          items: itemLines,
        });
      }

      if (notifyUpdated.length > 0) {
        const itemLines = notifyUpdated.map(
          ({ vehicle, priorPrice }) =>
            `${summarize(vehicle, fbt)} [was $${Number(priorPrice).toLocaleString()}]`
        );
        await notifier.send({
          title: `Tesla price change (${modelLabel}): ${notifyUpdated.length} vehicle${notifyUpdated.length > 1 ? "s" : ""}`,
          body: stateWatches[0].inventoryUrl,
          items: itemLines,
        });
      }

      recordRun(db, watchId, {
        status: pageState,
        vehicleCount: vehicles.length,
        added: added.length,
        removed: removed.length,
        updated: updated.length,
      });

      results.push({
        watch: modelLabel,
        status: pageState,
        vehicles: vehicles.length,
        added: added.length,
        removed: removed.length,
        updated: updated.length,
      });
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  return results;
}
