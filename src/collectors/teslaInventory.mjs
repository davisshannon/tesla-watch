import { normalizeVehicle } from "../parsers/normalizeVehicle.mjs";
import { log } from "../utils/log.mjs";
import { sleep } from "../utils/retry.mjs";

const API_BASE = "https://www.tesla.com/inventory/api/v4/inventory-results";
const PAGE_SIZE = 24;

export async function collectInventory(page, config) {
  const { inventoryUrl, region } = config;

  const parsed = new URL(inventoryUrl);
  const model = parsed.pathname.split("/").pop();
  const cleanUrl = `${parsed.origin}${parsed.pathname}`;

  // Navigate to this model's inventory page if not already there.
  // Ensures session cookies/tokens are scoped to the right model before fetching.
  if (!page.url().includes(`/inventory/new/${model}`)) {
    log.info(`Navigating to ${model} inventory page`);
    await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await sleep(3000);
    log.info(`Page now at ${page.url()}`);
  }

  log.info(`Fetching inventory for ${model}${region ? ` (region: ${region})` : ""} via API`);

  try {
    const { vehicles, total } = await fetchAllPages(page, model, region);
    log.info(`${model}: ${vehicles.length} of ${total} vehicles fetched`);
    return { vehicles, pageState: vehicles.length > 0 ? "inventory" : "no-stock" };
  } catch (err) {
    log.warn(`${model} API fetch failed: ${err.message}`);
    const isAccessDenied = err.message.includes("403");
    return { vehicles: [], pageState: isAccessDenied ? "blocked" : "error" };
  }
}

async function fetchAllPages(page, model, region) {
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
        ...(region && { region }),
      },
      offset,
      count: PAGE_SIZE,
      outsideOffset: 0,
      outsideSearch: false,
      isFalconDeliverySelectionEnabled: true,
      version: "v2",
    };

    const url = `${API_BASE}?query=${encodeURIComponent(JSON.stringify(query))}`;

    const json = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }, url);

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
