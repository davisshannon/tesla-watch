import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import {
  openDb,
  queryVehicles,
  queryEvents,
  queryRuns,
  queryStockHistory,
  queryRestockScatter,
  queryAllWatches,
  queryCurrentStatus,
  queryDistinctStates,
  queryDistinctTrims,
  queryStockByState,
  queryTimeOnLot,
  queryMultiStintVehicles,
} from "../db/database.mjs";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLIST_CHECKER = "com.tesla-watch.checker";
const PLIST_SERVER  = "com.tesla-watch.server";

async function readConfigFile(configPath) {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfigFile(configPath, data) {
  await writeFile(configPath, JSON.stringify(data, null, 2));
}

async function plistStatus(label) {
  try {
    const { stdout } = await execAsync(`launchctl list ${label} 2>/dev/null`);
    const pid = stdout.match(/"PID"\s*=\s*(\d+)/)?.[1];
    const status = stdout.match(/"LastExitStatus"\s*=\s*(\d+)/)?.[1];
    if (pid) return { running: true, pid: Number(pid), lastExitStatus: status ? Number(status) : null };
  } catch { /* fall through to process check */ }

  // launchctl has no PID (service not loaded or started manually) — fall back
  // to checking for a running process that matches the label's script pattern.
  try {
    const script = label === PLIST_SERVER ? "cli.mjs serve" : "cli.mjs run";
    const { stdout: ps } = await execAsync(`pgrep -f "${script}" 2>/dev/null || true`);
    const pid = ps.trim().split("\n").find(Boolean);
    return { running: !!pid, pid: pid ? Number(pid) : null, lastExitStatus: null };
  } catch {
    return { running: false, pid: null, lastExitStatus: null };
  }
}

function plistPath(label) {
  return `${homedir()}/Library/LaunchAgents/${label}.plist`;
}

async function reloadPlist(label) {
  try {
    const p = plistPath(label);
    await execAsync(`launchctl unload "${p}" 2>/dev/null; launchctl load "${p}"`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getCheckerInterval() {
  try {
    const raw = await readFile(plistPath(PLIST_CHECKER), "utf8");
    const match = raw.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    return match ? Number(match[1]) : 300;
  } catch {
    return 300;
  }
}

async function setCheckerInterval(seconds) {
  const p = plistPath(PLIST_CHECKER);
  const raw = await readFile(p, "utf8");
  const updated = raw.replace(
    /(<key>StartInterval<\/key>\s*<integer>)\d+(<\/integer>)/,
    `$1${seconds}$2`
  );
  await writeFile(p, updated);
  await reloadPlist(PLIST_CHECKER);
}

export async function startServer(config, configPath = "./tesla-watch.config.json") {
  const db = await openDb(config.dbFile);
  const app = express();
  const port = config.server?.port ?? 3737;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ── Config API ──────────────────────────────────────────────────────────

  app.get("/api/config", async (req, res) => {
    try {
      res.json(await readConfigFile(configPath));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const current = await readConfigFile(configPath);
      const updated = deepMerge(current, req.body);
      await writeConfigFile(configPath, updated);
      res.json({ ok: true, config: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Plist / scheduler API ───────────────────────────────────────────────

  app.get("/api/scheduler", async (req, res) => {
    try {
      const checker = await plistStatus(PLIST_CHECKER);
      // Server is always running if this endpoint is reachable
      const server = { running: true, pid: process.pid, lastExitStatus: null };
      res.json({ checker, server });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/scheduler/reload", async (req, res) => {
    try {
      const target = req.body?.target ?? "checker";
      const label = target === "server" ? PLIST_SERVER : PLIST_CHECKER;
      // Respond first, then reload — if reloading ourselves we'd kill the connection mid-response
      res.json({ ok: true });
      setTimeout(() => reloadPlist(label), 300);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/scheduler/interval", async (req, res) => {
    try {
      res.json({ seconds: await getCheckerInterval() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/scheduler/interval", async (req, res) => {
    try {
      const seconds = Number(req.body?.seconds);
      if (!seconds || seconds < 60) return res.status(400).json({ error: "Minimum interval is 60 seconds" });
      await setCheckerInterval(seconds);
      res.json({ ok: true, seconds });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Data API ────────────────────────────────────────────────────────────

  app.get("/api/status", (req, res) => {
    try { res.json(queryCurrentStatus(db, { state: req.query.state || undefined })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/states", (req, res) => {
    try { res.json(queryDistinctStates(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/stock-by-state", (req, res) => {
    try { res.json(queryStockByState(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/watches", (req, res) => {
    try { res.json(queryAllWatches(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/vehicles", (req, res) => {
    try {
      const watchId = req.query.watch_id != null ? Number(req.query.watch_id) : undefined;
      const active = req.query.active === "true" ? true : req.query.active === "false" ? false : undefined;
      const trim = req.query.trim || undefined;
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      const offset = Number(req.query.offset ?? 0);
      res.json(queryVehicles(db, { watchId, active, trim, limit, offset }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/trims", (req, res) => {
    try {
      const watchId = req.query.watch_id != null ? Number(req.query.watch_id) : undefined;
      res.json(queryDistinctTrims(db, { watchId }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/events", (req, res) => {
    try {
      const watchId = req.query.watch_id != null ? Number(req.query.watch_id) : undefined;
      const type = req.query.type || undefined;
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const offset = Number(req.query.offset ?? 0);
      res.json(queryEvents(db, { watchId, type, limit, offset }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/runs", (req, res) => {
    try {
      const watchId = req.query.watch_id != null ? Number(req.query.watch_id) : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 500);
      res.json(queryRuns(db, { watchId, limit }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/history/stock", (req, res) => {
    try {
      const watchId = req.query.watch_id != null ? Number(req.query.watch_id) : undefined;
      const days = Math.min(Number(req.query.days ?? 30), 365);
      res.json(queryStockHistory(db, { watchId, days }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/multi-stint", (req, res) => {
    try { res.json(queryMultiStintVehicles(db)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/time-on-lot", (req, res) => {
    try { res.json(queryTimeOnLot(db, { state: req.query.state || undefined })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/api/history/restock", (req, res) => {
    try {
      const days = Math.min(Number(req.query.days ?? 30), 365);
      const state = req.query.state || undefined;
      res.json(queryRestockScatter(db, { days, state }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // SPA fallback
  app.get("*path", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  app.listen(port, () => {
    console.log(`Tesla Watch dashboard: http://localhost:${port}`);
  });
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
