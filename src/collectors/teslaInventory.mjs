import { navigateToInventory, detectPageState } from "../browser/chrome.mjs";
import { normalizeVehicle } from "../parsers/normalizeVehicle.mjs";
import { log } from "../utils/log.mjs";

export async function collectInventory(page, config) {
  const { inventoryUrl, waitMs = 8000 } = config;

  let apiVehicles = null;

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!url.includes("/inventory/api/")) return;
      if (response.status() < 200 || response.status() >= 300) return;

      const text = await response.text();
      const json = JSON.parse(text);

      const total = json?.total_matches_found ?? null;
      const results = json?.results ?? json?.data ?? json?.response?.results ?? json?.response?.data ?? null;

      if (total !== null) log.info(`Inventory API: ${total} total matches`);

      if (Array.isArray(results) && results.length > 0) {
        apiVehicles = results.map(normalizeVehicle);
        log.info(`Intercepted API response: ${apiVehicles.length} vehicles`);
      } else if (total === 0 || results === null) {
        apiVehicles = [];
        log.info("Inventory API confirmed: no stock");
      }
    } catch (err) {
      log.debug(`Response handler error: ${err.message}`);
    }
  };

  let pageState;
  for (let attempt = 1; attempt <= 3; attempt++) {
    apiVehicles = null;
    page.on("response", onResponse);
    try {
      pageState = await navigateToInventory(page, inventoryUrl, { waitMs });
    } finally {
      page.off("response", onResponse);
    }

    if (pageState === "blocked") {
      log.warn(`Akamai/CDN block detected on ${inventoryUrl} — skipping. Clear ~/chrome-tesla-automation to reset fingerprint.`);
      return { vehicles: [], pageState };
    }

    // API fired — we have results regardless of page state
    if (apiVehicles !== null) {
      return { vehicles: apiVehicles, pageState: apiVehicles.length > 0 ? "inventory" : "no-stock" };
    }

    if (pageState !== "locale-select") break;

    log.warn(`Locale selector on attempt ${attempt} and API did not fire — retrying`);
  }

  if (pageState === "locale-select") {
    log.warn("Locale selection page still showing after all attempts.");
    return { vehicles: [], pageState };
  }

  log.warn(`API did not fire. Final page state: ${pageState}`);
  return { vehicles: [], pageState };
}
