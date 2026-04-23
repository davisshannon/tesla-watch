import { ensureChrome, connectChrome, getPage, warmUpBrowser } from "./browser/chrome.mjs";
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

export async function runOnce(config) {
  const db = await openDb(config.dbFile);
  const notifier = buildNotifier(config.notify);
  const fbt = config.fbtThreshold ?? null;
  const triggers = config.notify?.triggers ?? ["new_stock", "price_drop"];
  const filterConfig = config.notify?.filters ?? {};

  await ensureChrome();
  const browser = await connectChrome();
  const page = await getPage(browser);
  await warmUpBrowser(page);

  const results = [];

  try {
    for (const watch of config.watches) {
      log.info(`--- Watch: ${watch.label} ---`);

      const watchKey = { model: watch.model, category: watch.category ?? "", label: watch.label, market: watch.market ?? "en_AU" };
      const watchId = upsertWatch(db, watchKey);
      const seenIds = getSeenIds(db, watchId);

      let vehicles = [];
      let pageState = "error";

      try {
        const result = await collectInventory(page, {
          inventoryUrl: watch.inventoryUrl,
          localeBaseUrl: watch.localeBaseUrl,
          waitMs: config.waitMs,
          region: watch.region,
        });
        vehicles = result.vehicles;
        pageState = result.pageState;
        log.info(`${watch.label}: ${vehicles.length} vehicles (${pageState})`);
      } catch (err) {
        log.error(`${watch.label} collect failed: ${err.message}`);
      }

      if (pageState === "blocked" || pageState === "error") {
        log.warn(`${watch.label}: skipping diff — ${pageState}`);
        if (pageState === "blocked" && config.notify?.notifyOnBlock) {
          await notifier.send({ title: `Tesla Watch blocked (${watch.label})`, body: "Akamai is denying access. Delete ~/chrome-tesla-automation to reset." });
        }
        recordRun(db, watchId, { status: pageState, vehicleCount: 0, added: 0, removed: 0, updated: 0 });
        results.push({ watch: watch.label, status: pageState, vehicles: 0, added: 0, removed: 0, updated: 0 });
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
          title: `New Tesla stock (${watch.label}): ${notifyAdded.length} vehicle${notifyAdded.length > 1 ? "s" : ""}`,
          body: watch.inventoryUrl,
          items: itemLines,
        });
      }

      if (notifyUpdated.length > 0) {
        const itemLines = notifyUpdated.map(
          ({ vehicle, priorPrice }) =>
            `${summarize(vehicle, fbt)} [was $${Number(priorPrice).toLocaleString()}]`
        );
        await notifier.send({
          title: `Tesla price change (${watch.label}): ${notifyUpdated.length} vehicle${notifyUpdated.length > 1 ? "s" : ""}`,
          body: watch.inventoryUrl,
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
        watch: watch.label,
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
