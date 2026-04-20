import { readFile } from "fs/promises";
import path from "path";

export const AU_STATES = ["VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

function buildDefaultWatches() {
  return [
    { model: "my", label: "Model Y (All AU)", market: "en_AU" },
    { model: "m3", label: "Model 3 (All AU)", market: "en_AU" },
  ];
}

const DEFAULTS = {
  chromeDebugUrl: "http://localhost:9222",
  dbFile: "./data/tesla-watch.db",
  logFile: "./data/tesla-watch.log",
  waitMs: 8000,
  fbtThreshold: 91387,
  sort: "plh",
  server: {
    port: 3737,
  },
  notify: {
    imessage: {
      enabled: false,
      to: "",
    },
    triggers: ["new_stock", "price_drop"],
    filters: {
      maxPrice: null,
      states: null,
      models: null,
      variants: null,
      fbtOnly: false,
    },
  },
  watches: buildDefaultWatches(),
};

export async function loadConfig(configPath = "./tesla-watch.config.json") {
  let fileConfig = {};
  try {
    const raw = await readFile(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to parse config at ${configPath}: ${err.message}`);
    }
  }

  const merged = deepMerge(DEFAULTS, fileConfig);

  merged.watches = merged.watches.map((w) => ({
    ...w,
    inventoryUrl: buildInventoryUrl(w, merged.sort),
    localeBaseUrl: w.market === "en_AU" ? "https://www.tesla.com/en_AU" : null,
  }));

  return merged;
}

export function buildInventoryUrl(watch, sort = "plh") {
  const base = `https://www.tesla.com/${watch.market}/inventory/new/${watch.model}`;
  const params = new URLSearchParams({ arrangeby: sort });
  if (watch.category) params.set("CATEGORY", watch.category);
  params.set("range", "0");
  return `${base}?${params}`;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object") {
      out[k] = deepMerge(target[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
