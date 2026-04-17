import puppeteer from "puppeteer-core";
import { spawn } from "child_process";
import { log } from "../utils/log.mjs";
import { retry, sleep } from "../utils/retry.mjs";

const CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_USER_DATA = `${process.env.HOME}/chrome-tesla-automation`;

/**
 * Check if Chrome is already listening on the debug port.
 */
async function isChromeRunning(debugUrl) {
  try {
    const res = await fetch(`${debugUrl}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn Chrome in the background with the debug port open.
 * Returns immediately — Chrome continues running after the script exits.
 */
function spawnChrome(port = 9222) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_USER_DATA}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  log.info(`Launching Chrome: ${CHROME_BINARY}`);
  const child = spawn(CHROME_BINARY, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

/**
 * Ensure Chrome is running with the debug port open.
 * If it is not already up, launch it and wait for it to become ready.
 */
export async function ensureChrome(debugUrl = "http://localhost:9222") {
  const port = new URL(debugUrl).port || 9222;

  if (await isChromeRunning(debugUrl)) {
    log.info("Chrome already running on debug port");
    return;
  }

  log.info("Chrome not detected — launching it now…");
  spawnChrome(port);

  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    if (await isChromeRunning(debugUrl)) {
      log.info("Chrome is up");
      return;
    }
  }
  throw new Error(
    `Chrome did not start within timeout. Check that the binary exists at:\n  ${CHROME_BINARY}`
  );
}

/**
 * Connect to the Chrome instance via CDP using puppeteer-core.
 * Call ensureChrome() first if you want auto-launch behaviour.
 */
export async function connectChrome(debugUrl = "http://localhost:9222") {
  return retry(
    async () => {
      log.info(`Connecting to Chrome at ${debugUrl}`);
      const browser = await puppeteer.connect({
        browserURL: debugUrl,
        defaultViewport: null,
      });
      log.info("Connected to Chrome");
      return browser;
    },
    { attempts: 3, delayMs: 3000, label: "Chrome connect" }
  );
}

/**
 * Get or create a usable page from the browser.
 */
export async function getPage(browser) {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  return page;
}

/**
 * Detect the current state of a Tesla page so the runner knows what happened.
 * Returns one of: "locale-select" | "blocked" | "no-stock" | "inventory" | "loading" | "unknown"
 */
export async function detectPageState(page) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const url = page.url();

    if (/choose your region|select your country/i.test(bodyText)) {
      return "locale-select";
    }
    if (/access denied|blocked|403|captcha/i.test(bodyText)) {
      return "blocked";
    }
    if (/no inventory|no vehicles|no results found|0 results/i.test(bodyText)) {
      return "no-stock";
    }
    if (
      /\$[0-9,]+/.test(bodyText) &&
      /model [xysx3]|cybertruck/i.test(bodyText)
    ) {
      return "inventory";
    }
    if (url.includes("/inventory/")) {
      return "loading";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Navigate to the Tesla inventory URL, optionally handling a locale page first.
 * Returns the final detected page state.
 */
export async function navigateToInventory(page, inventoryUrl, opts = {}) {
  const { localeBaseUrl = null, waitMs = 8000 } = opts;

  if (localeBaseUrl) {
    log.info(`Navigating to locale base: ${localeBaseUrl}`);
    await page.goto(localeBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await sleep(3000);

    try {
      await page.waitForSelector("text/Australia", { timeout: 4000 });
      const el = await page.$("text/Australia");
      if (el) {
        await el.click();
        log.info("Clicked Australia locale");
        await sleep(4000);
      }
    } catch {
      log.info("Locale selection page not shown, continuing");
    }
  }

  log.info(`Navigating to inventory URL: ${inventoryUrl}`);
  await page.goto(inventoryUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(waitMs);

  const state = await detectPageState(page);
  log.info(`Page state after navigation: ${state}`);
  return state;
}
