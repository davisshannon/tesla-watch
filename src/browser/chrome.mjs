import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { log } from "../utils/log.mjs";
import { retry, sleep } from "../utils/retry.mjs";
import { mkdir } from "fs/promises";

puppeteerExtra.use(StealthPlugin());

const CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHROME_USER_DATA = `${process.env.HOME}/chrome-tesla-automation`;


let _browser = null;


export async function warmUpBrowser(page) {
  log.info("Warming up — visiting Tesla AU inventory page naturally");
  // Browse homepage first, then navigate to inventory via the site — avoids locale selector
  await page.goto("https://www.tesla.com/en_AU", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);
  await acceptCookies(page);
  // Now navigate to inventory naturally
  await page.goto("https://www.tesla.com/en_AU/inventory/new/my", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3000);
  await acceptCookies(page);
  await confirmLocationModal(page, "https://www.tesla.com/en_AU/inventory/new/my");
  await sleep(2000);
  log.info("Warm-up complete — locale established");
}

export async function ensureChrome() {
  // Ensure the user data dir exists but keep cookies/session intact between runs
  await mkdir(CHROME_USER_DATA, { recursive: true });
}

export async function connectChrome() {
  return retry(
    async () => {
      log.info("Launching Chrome via puppeteer");
      _browser = await puppeteerExtra.launch({
        executablePath: CHROME_BINARY,
        headless: false,
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
      log.info("Chrome launched (non-headless, cookies persisted)");
      return _browser;
    },
    { attempts: 3, delayMs: 3000, label: "Chrome launch" }
  );
}

export async function getPage(browser) {
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  // Don't override UA — let Chrome send its real version so sec-ch-ua headers match
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-AU,en;q=0.9" });

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
  const { waitMs = 8000 } = opts;

  log.info(`Navigating to inventory URL: ${inventoryUrl}`);
  await page.goto(inventoryUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);
  await confirmLocationModal(page, inventoryUrl);

  await sleep(waitMs);

  const state = await detectPageState(page);
  log.info(`Page state after navigation: ${state}`);
  return state;
}

async function acceptCookies(page) {
  try {
    const accepted = await page.evaluate(() => {
      const btn = document.getElementById("tsla-accept-cookie");
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (accepted) {
      log.info("Accepted cookie banner");
      await sleep(1000);
    }
  } catch (err) {
    log.debug(`Cookie banner: ${err.message}`);
  }
}

async function confirmLocationModal(page, inventoryUrl) {
  try {
    const confirmBtn = await page.$("button.tds-btn--width-full");
    if (!confirmBtn) return;
    const text = await page.evaluate(b => b.textContent.trim(), confirmBtn);
    if (text !== "Confirm") return;

    log.info("Clicking Confirm on location modal");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
      confirmBtn.click(),
    ]);
    await sleep(2000);

    // Confirm navigates to the country selector — navigate directly to target URL
    const isLocaleSelector = await page.evaluate(() =>
      !!document.querySelector(".tds-locale-selector-superregion")
    );
    if (isLocaleSelector) {
      log.info("Country selector shown — navigating directly to inventory URL");
      await page.goto(inventoryUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(3000);
    }
  } catch (err) {
    log.debug(`Location modal: ${err.message}`);
  }
}
