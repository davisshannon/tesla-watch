import { log } from "./log.mjs";

/**
 * Retry an async fn up to `attempts` times with exponential backoff.
 * @param {() => Promise<any>} fn
 * @param {{ attempts?: number, delayMs?: number, label?: string }} opts
 */
export async function retry(fn, { attempts = 3, delayMs = 2000, label = "operation" } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.warn(`${label} failed (attempt ${i}/${attempts}): ${err.message}`);
      if (i < attempts) {
        await sleep(delayMs * i);
      }
    }
  }
  throw lastErr;
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
