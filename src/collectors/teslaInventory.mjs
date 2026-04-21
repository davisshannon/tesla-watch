import { normalizeVehicle } from "../parsers/normalizeVehicle.mjs";
import { log } from "../utils/log.mjs";
import { sleep } from "../utils/retry.mjs";

const API_BASE = "https://www.tesla.com/inventory/api/v4/inventory-results";
const PAGE_SIZE = 24;

export async function collectInventory(page, config) {
  const { inventoryUrl } = config;

  const parsed = new URL(inventoryUrl);
  const model = parsed.pathname.split("/").pop();
  const cleanUrl = `${parsed.origin}${parsed.pathname}`;

  log.info(`Fetching inventory for ${model} via API`);

  try {
    const { vehicles, total } = await fetchAllPages(page, model, cleanUrl);
    log.info(`${model}: ${vehicles.length} of ${total} vehicles fetched`);
    return { vehicles, pageState: vehicles.length > 0 ? "inventory" : "no-stock" };
  } catch (err) {
    log.warn(`${model} API fetch failed: ${err.message}`);
    const isAccessDenied = err.message.includes("403");
    return { vehicles: [], pageState: isAccessDenied ? "blocked" : "error" };
  }
}

async function fetchAllPages(page, model, inventoryPageUrl) {
  const allVehicles = [];
  let offset = 0;
  let total = null;

  do {
    if (offset > 0) await sleep(1500 + Math.random() * 1500);

    const query = {
      query: {
        model,
        condition: "new",
        options: {},
        arrangeby: "Price",
        order: "asc",
        market: "AU",
        language: "en",
        super_region: "north america",
      },
      offset,
      count: PAGE_SIZE,
      outsideOffset: 0,
      outsideSearch: false,
      isFalconDeliverySelectionEnabled: true,
      version: "v2",
    };

    const apiUrl = `${API_BASE}?query=${encodeURIComponent(JSON.stringify(query))}`;

    // Intercept the API response fired by the page's own SPA (carries correct
    // auth headers) rather than issuing a manual fetch that can 403.
    const json = await interceptOrFetch(page, model, inventoryPageUrl, apiUrl, offset);

    if (total === null) {
      total = json?.total_matches_found ?? 0;
      log.info(`Inventory API: ${total} total matches`);
    }

    const results = json?.results ?? json?.data ?? json?.response?.results ?? json?.response?.data ?? null;
    if (!Array.isArray(results) || results.length === 0) break;

    allVehicles.push(...results.map(normalizeVehicle));
    log.info(`Fetched offset ${offset}: +${results.length} vehicles (${allVehicles.length} total)`);
    offset += PAGE_SIZE;
  } while (allVehicles.length < total);

  return { vehicles: allVehicles, total: total ?? 0 };
}

// For offset 0: navigate to the inventory page and capture the API call the
// SPA fires automatically (same headers/tokens Tesla's own code uses).
// For subsequent offsets: manual fetch is fine — session is warm by then.
async function interceptOrFetch(page, model, inventoryPageUrl, apiUrl, offset) {
  if (offset > 0) {
    return page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }, apiUrl);
  }

  // Set up response interception before navigating
  let resolveCapture, rejectCapture;
  const captured = new Promise((res, rej) => { resolveCapture = res; rejectCapture = rej; });

  // URL-encoded form of "model":"m3" / "model":"my" in the query param
  const modelToken = encodeURIComponent(`"model":"${model}"`);

  const handler = async (response) => {
    if (response.url().startsWith(API_BASE) && response.url().includes(modelToken)) {
      try {
        resolveCapture(await response.json());
      } catch (e) {
        rejectCapture(e);
      }
    }
  };
  page.on("response", handler);

  const timeout = setTimeout(() => rejectCapture(new Error("intercept timeout")), 15000);

  try {
    log.info(`Navigating to ${model} inventory page to capture SPA API call`);
    await page.goto(inventoryPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    const json = await captured;
    return json;
  } finally {
    clearTimeout(timeout);
    page.off("response", handler);
  }
}
