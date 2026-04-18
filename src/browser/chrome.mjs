import puppeteer from "puppeteer-core";
import { log } from "../utils/log.mjs";
import { retry, sleep } from "../utils/retry.mjs";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHROME_USER_DATA = `${process.env.HOME}/chrome-tesla-automation`;

// Realistic Chrome user agent — keeps in sync with whatever version is installed
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let _browser = null;

async function clearUserDataDir() {
  try {
    if (existsSync(CHROME_USER_DATA)) {
      await rm(CHROME_USER_DATA, { recursive: true, force: true });
    }
    await mkdir(CHROME_USER_DATA, { recursive: true });
    log.info("Cleared Chrome user data dir");
  } catch (err) {
    log.warn(`Could not clear user data dir: ${err.message}`);
  }
}

export async function ensureChrome() {
  // Always start fresh — clear stored fingerprint/cookies before each run
  await clearUserDataDir();
}

export async function connectChrome() {
  return retry(
    async () => {
      log.info("Launching Chrome via puppeteer");
      _browser = await puppeteer.launch({
        executablePath: CHROME_BINARY,
        headless: true,
        userDataDir: CHROME_USER_DATA,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=1280,900",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });
      log.info("Chrome launched");
      return _browser;
    },
    { attempts: 3, delayMs: 3000, label: "Chrome launch" }
  );
}

export async function getPage(browser) {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  // Spoof user agent and hide webdriver fingerprints
  await page.setUserAgent(USER_AGENT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
    window.chrome = { runtime: {} };
  });

  return page;
}

export async function detectPageState(page) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const url = page.url();

    if (/choose your region|select your country/i.test(bodyText)) {
      return "locale-select";
    }
    if (/access denied|blocked|403|captcha|unusual traffic|bot/i.test(bodyText)) {
      return "blocked";
    }
    if (/no inventory|no vehicles|no results found|0 results/i.test(bodyText)) {
      return "no-stock";
    }
    if (/\$[0-9,]+/.test(bodyText) && /model [xysx3]|cybertruck/i.test(bodyText)) {
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

export async function navigateToInventory(page, inventoryUrl, opts = {}) {
  const { localeBaseUrl = null, waitMs = 8000 } = opts;

  if (localeBaseUrl) {
    log.info(`Navigating to locale base: ${localeBaseUrl}`);
    await page.goto(localeBaseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
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
  await page.goto(inventoryUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(waitMs);

  const state = await detectPageState(page);
  log.info(`Page state after navigation: ${state}`);
  return state;
}
