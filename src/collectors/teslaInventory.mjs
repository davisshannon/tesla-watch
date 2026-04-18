import { navigateToInventory } from "../browser/chrome.mjs";
import { normalizeVehicle } from "../parsers/normalizeVehicle.mjs";
import { log } from "../utils/log.mjs";
import { sleep } from "../utils/retry.mjs";

/**
 * Collect Tesla inventory vehicles from a page.
 *
 * Strategy:
 * 1. Attach a response interceptor BEFORE reloading so we catch the API call.
 * 2. Reload the page to trigger fresh API requests.
 * 3. Wait for responses. If the API fired, use those results.
 * 4. Fall back to DOM scraping if no API response was captured.
 *
 * Returns { vehicles: NormalizedVehicle[], pageState: string }
 */
export async function collectInventory(page, config) {
  const { inventoryUrl, localeBaseUrl = null, waitMs = 8000 } = config;

  // Navigate (handles locale page too)
  const pageState = await navigateToInventory(page, inventoryUrl, { waitMs });

  if (pageState === "blocked") {
    log.warn("Page appears blocked. Cannot collect inventory.");
    return { vehicles: [], pageState };
  }
  if (pageState === "locale-select") {
    log.warn("Locale selection page still showing after navigation.");
    return { vehicles: [], pageState };
  }

  // Intercept API responses on reload
  let apiVehicles = null;

  const onResponse = async (response) => {
    try {
      const url = response.url();
      // Log all tesla.com API calls so we can identify the right endpoint
      if (url.includes("tesla.com") && url.includes("/api/")) {
        log.debug(`API response: ${response.status()} ${url}`);
      }
      if (!url.includes("/inventory/api/")) return;
      if (response.status() < 200 || response.status() >= 300) return;

      const text = await response.text();
      const json = JSON.parse(text);

      const total = json?.total_matches_found ?? null;
      const results = json?.results ?? json?.data ?? json?.response?.results ?? json?.response?.data ?? null;

      if (total !== null) {
        log.info(`Inventory API: ${total} total matches`);
      }

      if (Array.isArray(results) && results.length > 0) {
        apiVehicles = results.map(normalizeVehicle);
        log.info(`Intercepted API response: ${apiVehicles.length} vehicles`);
      } else if (total === 0 || results === null) {
        // Tesla returns null results when there is no stock — treat as confirmed empty
        apiVehicles = [];
        log.info("Inventory API confirmed: no stock");
      } else {
        log.debug(`Inventory API matched but could not parse results`, Object.keys(json));
      }
    } catch (err) {
      log.debug(`Response handler error: ${err.message}`);
    }
  };

  page.on("response", onResponse);

  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    // Give time for async API calls to complete after DOM load
    await sleep(waitMs);
  } finally {
    page.off("response", onResponse);
  }

  if (apiVehicles !== null) {
    // API responded — trust it (may be empty if no stock)
    return { vehicles: apiVehicles, pageState: apiVehicles.length > 0 ? "inventory" : "no-stock" };
  }

  // API never fired — fall back to page state detection
  const finalState = await import("../browser/chrome.mjs").then((m) =>
    m.detectPageState(page)
  );
  log.warn(`API did not fire. Final page state: ${finalState}`);
  return { vehicles: [], pageState: finalState };
}

async function scrapeFromDom(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const lines = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    return lines
      .filter((line) => /\$[0-9,]+/.test(line) || /model [yyx3]/i.test(line))
      .map((line, idx) => ({
        vin: "",
        inventoryId: `dom-${idx}`,
        price: line.match(/\$([0-9,]+)/)?.[1]?.replace(/,/g, "") || "",
        odometer: line.match(/([0-9,]+)\s*(km|kilomet)/i)?.[1]?.replace(/,/g, "") || "",
        trim: /model [yyx3]/i.test(line) ? line.slice(0, 60) : "",
        wheels: "",
        exterior: "",
        interior: "",
        location: "",
        year: "",
        model: "",
        raw: { line, idx },
      }));
  });
}
