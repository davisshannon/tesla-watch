import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { log } from "../utils/log.mjs";
import { retry, sleep } from "../utils/retry.mjs";
import { mkdir } from "fs/promises";

puppeteerExtra.use(StealthPlugin());

const CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CHROME_USER_DATA = `${process.env.HOME}/chrome-tesla-automation`;

const AU_LOCALE_COOKIES = [
  { name: "tsla-locale", value: "en_AU", domain: ".tesla.com", path: "/" },
  { name: "userCountry", value: "AU", domain: ".tesla.com", path: "/" },
];

let _browser = null;

async function setLocaleCookies(page) {
  await page.setCookie(...AU_LOCALE_COOKIES);
}

export async function warmUpBrowser(page) {
  // Set locale cookies first so Tesla routes us directly to AU inventory.
  await setLocaleCookies(page);

  log.info("Warming up — navigating directly to AU inventory");
  await page.goto("https://www.tesla.com/en_AU/inventory/new/my", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(3000);
  await acceptCookies(page);

  // If the country selector appeared it will have redirected us away — navigate back to inventory.
  const selected = await selectAustralia(page);
  if (selected) {
    await sleep(1000);
    await page.goto("https://www.tesla.com/en_AU/inventory/new/my", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
  }

  await dismissConfirmModal(page);
  await sleep(1000);

  log.info(`Warm-up complete — locale established, at ${page.url()}`);
}

export async function ensureChrome() {
  await mkdir(CHROME_USER_DATA, { recursive: true });
  // Kill any leftover Chrome using our profile so puppeteer can launch fresh
  const { execSync } = await import("child_process");
  try {
    execSync(`pkill -f "chrome-tesla-automation" 2>/dev/null || true`, { shell: true });
    await sleep(1500);
  } catch {}
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
    const isLocaleSelector = await page.evaluate(() =>
      !!document.querySelector(".tds-locale-selector-superregion, .tds-locale-selector")
    );
    if (isLocaleSelector) return "locale-select";

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const url = page.url();

    if (/choose your region|select your country/i.test(bodyText)) {
      return "locale-select";
    }
    if (/access denied|blocked|403|captcha|unusual traffic|bot/i.test(bodyText) || /reference #[\d.]+/i.test(bodyText)) {
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

  // Strip query params — they trigger the country selector. The inventory API
  // fires regardless and returns all vehicles; params only affect sort/range UI.
  const parsed = new URL(inventoryUrl);
  const cleanUrl = `${parsed.origin}${parsed.pathname}`;

  await setLocaleCookies(page);
  log.info(`Navigating to inventory URL: ${cleanUrl}`);
  await page.goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  await handleLocaleSelector(page, cleanUrl);
  await dismissConfirmModal(page);
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

async function selectAustralia(page) {
  try {
    // Wait up to 5s for the country selector to appear
    await page.waitForSelector(".tds-locale-selector-superregion, .tds-locale-selector", { timeout: 5000 }).catch(() => {});

    const isLocaleSelector = await page.evaluate(() =>
      !!document.querySelector(".tds-locale-selector-superregion, .tds-locale-selector")
    );
    if (!isLocaleSelector) {
      log.info("No country selector present — skipping");
      return false;
    }

    log.info("Country selector shown — clicking Australia");
    // Find the exact link whose href ends with /en_AU (not /en_AU/something)
    const href = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      const au = links.find(a => /\/en_au\/?$/i.test(a.getAttribute("href")));
      return au ? au.getAttribute("href") : null;
    });

    if (href) {
      log.info(`Found Australia link: ${href}`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}),
        page.evaluate(h => document.querySelector(`a[href="${h}"]`)?.click(), href),
      ]);
      await sleep(1500);
      log.info(`Australia selected — now at ${page.url()}`);
      return true;
    }

    log.warn("Could not find Australia link — dumping all hrefs for debugging");
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href")).slice(0, 30)
    );
    log.warn(hrefs.join(", "));
    return false;
  } catch (err) {
    log.debug(`selectAustralia: ${err.message}`);
    return false;
  }
}

async function dismissConfirmModal(page) {
  try {
    // If the "Confirm" modal is shown, close it with the X/dismiss button rather than Confirm
    // (clicking Confirm redirects to the country selector)
    const dismissed = await page.evaluate(() => {
      // Try close/dismiss button first
      const close = document.querySelector("button[aria-label='Close'], button.tds-modal-close, button[data-id='modal-close']");
      if (close) { close.click(); return "close-btn"; }
      // Press Escape to dismiss
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return "escape";
    });
    log.info(`Confirm modal dismissed via: ${dismissed}`);
    await sleep(500);
  } catch (err) {
    log.debug(`dismissConfirmModal: ${err.message}`);
  }
}

async function handleLocaleSelector(page, inventoryUrl) {
  try {
    const selected = await selectAustralia(page);
    if (!selected) return;
    // After selecting Australia, navigate to the intended inventory URL
    await page.goto(inventoryUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
  } catch (err) {
    log.debug(`Locale selector handler: ${err.message}`);
  }
}
