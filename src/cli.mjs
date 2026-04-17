#!/usr/bin/env node
import { parseArgs } from "util";
import { readFile, writeFile } from "fs/promises";
import { createInterface } from "readline";
import { loadConfig } from "./config.mjs";
import { runOnce } from "./runner.mjs";
import { openDb, getSeenIds, queryCurrentStatus, queryAllWatches } from "./db/database.mjs";
import { ensureChrome, connectChrome, getPage, detectPageState } from "./browser/chrome.mjs";
import { sendIMessage } from "./notify/imessage.mjs";
import { setLogFile, log } from "./utils/log.mjs";
import { sleep } from "./utils/retry.mjs";
import { startServer } from "./server/server.mjs";

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config:   { type: "string",  short: "c", default: "./tesla-watch.config.json" },
    interval: { type: "string",  short: "i", default: "15m" },
    port:     { type: "string",  short: "p" },
    verbose:  { type: "boolean", short: "v", default: false },
    help:     { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const command = positionals[0] || "run";

async function main() {
  if (flags.help || command === "help") {
    printHelp();
    process.exit(0);
  }

  const config = await loadConfig(flags.config);
  if (flags.port) config.server = { ...config.server, port: Number(flags.port) };
  if (config.logFile) setLogFile(config.logFile);

  const needsPhone = ["run", "watch", "test-imessage"].includes(command);
  if (needsPhone && config.notify?.imessage?.enabled) {
    await ensurePhoneNumber(config, flags.config);
  }

  switch (command) {
    case "run":          await cmdRun(config); break;
    case "watch":        await cmdWatch(config, flags.interval); break;
    case "serve":        await cmdServe(config); break;
    case "test-imessage":await cmdTestIMessage(config); break;
    case "test-browser": await cmdTestBrowser(config); break;
    case "show-state":   await cmdShowState(config); break;
    case "reset-state":  await cmdResetState(config); break;
    default:
      printHelp();
      process.exit(1);
  }
}

async function cmdRun(config) {
  log.info("Running one-shot inventory check");
  const results = await runOnce(config);
  log.info("Run complete", results);
  if (results.every((r) => r.status === "blocked")) process.exit(2);
}

async function cmdWatch(config, intervalStr) {
  const ms = parseInterval(intervalStr);
  log.info(`Starting watch mode — interval: ${intervalStr} (${ms}ms)`);
  while (true) {
    try {
      log.info("--- Watch tick ---");
      const results = await runOnce(config);
      log.info("Tick complete", results);
    } catch (err) {
      log.error(`Watch tick failed: ${err.message}`);
    }
    log.info(`Sleeping ${intervalStr}…`);
    await sleep(ms);
  }
}

async function cmdServe(config) {
  await startServer(config, flags.config);
  // Keep process alive
}

async function cmdTestIMessage(config) {
  const imCfg = config.notify?.imessage;
  if (!imCfg?.enabled || !imCfg?.to) {
    console.error("imessage not configured. Set notify.imessage.enabled=true and notify.imessage.to in config.");
    process.exit(1);
  }
  log.info(`Sending test iMessage to ${imCfg.to}`);
  await sendIMessage(imCfg.to, "tesla-watch: test message ✓");
  log.info("Test iMessage sent");
}

async function cmdTestBrowser(config) {
  log.info(`Testing browser connection: ${config.chromeDebugUrl}`);
  await ensureChrome(config.chromeDebugUrl);
  const browser = await connectChrome(config.chromeDebugUrl);
  const page = await getPage(browser);
  try {
    const state = await detectPageState(page);
    log.info(`Connected. Current page state: ${state}`);
    log.info(`Current URL: ${page.url()}`);
  } finally {
    try { browser.disconnect(); } catch {}
  }
}

async function cmdShowState(config) {
  const db = await openDb(config.dbFile);
  const status = queryCurrentStatus(db);
  const watches = queryAllWatches(db);
  console.log(`DB: ${config.dbFile}\n`);
  for (const w of status) {
    console.log(`[${w.label}]  active: ${w.active_count}  last_run: ${w.last_run || "never"}  status: ${w.last_status || "—"}`);
    const seenIds = getSeenIds(db, w.id);
    const ids = Object.keys(seenIds);
    if (ids.length) ids.forEach((id) => console.log(`  ${id}`));
  }
  if (!status.length) console.log("No watches in database yet.");
}

async function cmdResetState(config) {
  const db = await openDb(config.dbFile);
  const watches = queryAllWatches(db);
  const now = new Date().toISOString();
  for (const w of watches) {
    db.prepare("UPDATE vehicles SET removed_at = ? WHERE watch_id = ? AND removed_at IS NULL").run(now, w.id);
  }
  log.info("State reset — all vehicles marked removed. Next run will re-alert on all stock.");
}

async function ensurePhoneNumber(config, configPath) {
  if (config.notify?.imessage?.to) return;
  const answer = await prompt("Phone number for iMessage alerts (e.g. +61412345678): ");
  const phone = answer.trim();
  if (!phone) {
    console.error("No phone number provided. Notifications will be skipped.");
    return;
  }
  config.notify.imessage.to = phone;
  try {
    let raw = "{}";
    try { raw = await readFile(configPath, "utf8"); } catch {}
    const fileConfig = JSON.parse(raw);
    fileConfig.notify = fileConfig.notify || {};
    fileConfig.notify.imessage = fileConfig.notify.imessage || {};
    fileConfig.notify.imessage.to = phone;
    await writeFile(configPath, JSON.stringify(fileConfig, null, 2));
    log.info(`Saved phone number to ${configPath}`);
  } catch (err) {
    log.warn(`Could not save phone number to config: ${err.message}`);
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function parseInterval(str) {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid interval "${str}". Use e.g. 15m, 1h, 30s`);
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
}

function printHelp() {
  console.log(`
Usage: tesla-watch <command> [options]

Commands:
  run                  Run one inventory check across all watches
  watch                Run on a repeating interval (default: 15m)
  serve                Start the web dashboard
  test-imessage        Send a test iMessage to verify notifications
  test-browser         Verify Chrome CDP connection
  show-state           Print current saved state from DB
  reset-state          Mark all vehicles removed (triggers full re-alert next run)

Options:
  -c, --config <path>    Path to config JSON (default: ./tesla-watch.config.json)
  -i, --interval <str>   Watch interval, e.g. 15m, 1h, 30s (default: 15m)
  -p, --port <number>    Web server port (default: 3737)
  -v, --verbose          Verbose output
`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
