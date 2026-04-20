import { navigateToInventory } from "../browser/chrome.mjs";
import { normalizeVehicle } from "../parsers/normalizeVehicle.mjs";
import { log } from "../utils/log.mjs";
import { sleep } from "../utils/retry.mjs";

const PAGE_SIZE = 24;

export async function collectInventory(page, config) {
  const { inventoryUrl, waitMs = 8000 } = config;

  let apiVehicles = null;
  let apiUrl = null;
  let totalMatches = null;

  const onResponse = async (response) => {
    try {
      const url = response.url();
      if (!url.includes("/inventory/api/")) return;
      if (response.status() < 200 || response.status() >= 300) return;

      const text = await response.text();
      const json = JSON.parse(text);

      const total = json?.total_matches_found ?? null;
      const results = json?.results ?? json?.data ?? json?.response?.results ?? json?.response?.data ?? null;

      if (total !== null) {
        log.info(`Inventory API: ${total} total matches`);
        totalMatches = total;
        apiUrl = url;
      }

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
    apiUrl = null;
    totalMatches = null;
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

    if (apiVehicles !== null) break;
    if (pageState !== "locale-select") break;

    log.warn(`Locale selector on attempt ${attempt} and API did not fire — retrying`);
  }

  if (pageState === "locale-select") {
    log.warn("Locale selection page still showing after all attempts.");
    return { vehicles: [], pageState };
  }

  if (apiVehicles === null) {
    log.warn(`API did not fire. Final page state: ${pageState}`);
    return { vehicles: [], pageState };
  }

  // Fetch remaining pages if total exceeds first page
  if (apiUrl && totalMatches !== null && totalMatches > apiVehicles.length) {
    const remaining = totalMatches - apiVehicles.length;
    const extraPages = Math.ceil(remaining / PAGE_SIZE);
    log.info(`Fetching ${extraPages} more page(s) (${totalMatches} total vehicles)`);

    for (let i = 1; i <= extraPages; i++) {
      const offset = i * PAGE_SIZE;
      await sleep(1500 + Math.random() * 1500);
      try {
        const extra = await fetchPage(page, apiUrl, offset);
        if (extra.length === 0) break;
        apiVehicles.push(...extra);
        log.info(`Page ${i + 1}: +${extra.length} vehicles (${apiVehicles.length} total)`);
      } catch (err) {
        log.warn(`Pagination page ${i + 1} failed: ${err.message}`);
        break;
      }
    }
  }

  return { vehicles: apiVehicles, pageState: apiVehicles.length > 0 ? "inventory" : "no-stock" };
}

async function fetchPage(page, apiUrl, offset) {
  // Parse the query param, update offset, fetch via browser's session
  const url = new URL(apiUrl);
  const queryJson = JSON.parse(decodeURIComponent(url.searchParams.get("query")));
  queryJson.offset = offset;
  url.searchParams.set("query", JSON.stringify(queryJson));
  const fetchUrl = url.toString();

  const result = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, fetchUrl);

  const results = result?.results ?? result?.data ?? result?.response?.results ?? result?.response?.data ?? null;
  return Array.isArray(results) ? results.map(normalizeVehicle) : [];
}
