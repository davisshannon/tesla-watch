# tesla-watch

Tesla AU inventory monitor with iMessage notifications and a local web dashboard.

Polls Tesla's inventory API across all Australian states for Model Y and Model 3, stores history in SQLite, sends iMessage alerts when matching stock appears, and serves a dashboard at `http://localhost:3737`.

---

## Features

- Checks all AU states (VIC, NSW, QLD, WA, SA, TAS, ACT, NT) per model via `RegistrationProvince`
- iMessage alerts configurable by model, variant/trim keyword, state, max price, FBT eligibility
- SQLite history — vehicle first/last seen, price changes, removed stock
- Web dashboard — Australia map with inventory bubbles, stock timeline chart, vehicles table, event log, run log
- All config (filters, notification destination, check frequency) editable in the dashboard Settings tab — no file editing needed
- macOS launchd integration — checker runs every N minutes, web server runs permanently

---

## Requirements

- macOS (iMessage via AppleScript, launchd scheduler)
- Node.js 18+ (`__NODE__`)
- Google Chrome installed at `/Applications/Google Chrome.app`
- **iMessage notifications require your Apple ID to be signed in to Messages.app** on the Mac running this tool

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/davisshannon/tesla-watch.git
cd tesla-watch
```

### 2. Run setup

```bash
./tesla-watch.sh setup
```

This will:
- Detect your Node.js path
- Install npm dependencies
- Create `tesla-watch.config.json` from the example
- Install and load both launchd jobs (checker + web server)

### 3. Set your iMessage destination

Either edit `tesla-watch.config.json` and set `notify.imessage.to` to your phone number or iCloud email — or just open the dashboard and configure everything in **Settings**.

> **Note:** iMessage notifications require your Apple ID to be signed in to **Messages.app** on this Mac. The checker runs as a background launchd job, so Messages must be open or at least signed in for AppleScript to send messages.

### 4. Open the dashboard

```
http://localhost:3737
```

---

## Management script

`tesla-watch.sh` handles everything from a single entry point:

```bash
./tesla-watch.sh setup      # First-time install — deps, config, launchd jobs
./tesla-watch.sh start      # Load launchd jobs
./tesla-watch.sh stop       # Unload launchd jobs
./tesla-watch.sh restart    # Stop then start
./tesla-watch.sh status     # Show running state of all components
./tesla-watch.sh logs       # Show recent checker + server logs
./tesla-watch.sh logs check # Follow checker log live
./tesla-watch.sh logs server # Follow server log live
./tesla-watch.sh run        # Run one inventory check right now
./tesla-watch.sh uninstall  # Remove launchd plists
```

`setup` is idempotent — safe to re-run if you move the repo or need to re-register the launchd jobs.

---

## How it works

The **checker** (`cli.mjs run`) fires every 5 minutes via launchd:

1. Launches Chrome in headless CDP mode if not already running
2. For each model (MY, M3) × each AU state — navigates to the Tesla inventory page with `RegistrationProvince=<STATE>`
3. Intercepts the Tesla inventory API response
4. Diffs against previously seen vehicles in SQLite
5. Applies your notification filters
6. Sends an iMessage if matching new stock or price drops are found
7. Writes all vehicles, events, and run results to the database

The **web server** (`cli.mjs serve`) reads from the same database and serves the dashboard continuously.

---

## Configuration

`tesla-watch.config.json` — created by you, not committed to git.

| Field | Default | Description |
|---|---|---|
| `chromeDebugUrl` | `http://localhost:9222` | Chrome CDP debug URL |
| `dbFile` | `./data/tesla-watch.db` | SQLite database path |
| `logFile` | `./data/tesla-watch.log` | Log file path |
| `waitMs` | `8000` | Time to wait for Tesla API response per page (ms) |
| `fbtThreshold` | `91387` | FBT exemption threshold (AUD subtotal) |
| `sort` | `plh` | Sort order: `plh` price low→high, `phl` high→low, `n` newest |
| `server.port` | `3737` | Web dashboard port |
| `notify.imessage.enabled` | `false` | Enable iMessage notifications |
| `notify.imessage.to` | `""` | Phone number or iCloud email |
| `notify.triggers` | `["new_stock","price_drop"]` | Which events trigger a notification |
| `notify.filters.models` | `null` | Array of model codes to notify on, e.g. `["my"]`. `null` = all |
| `notify.filters.variants` | `null` | Trim keyword array, e.g. `["Performance","Long Range"]`. Partial match. `null` = all |
| `notify.filters.states` | `null` | State array, e.g. `["VIC","NSW"]`. `null` = all |
| `notify.filters.maxPrice` | `null` | Max drive-away price (AUD). `null` = no limit |
| `notify.filters.fbtOnly` | `false` | Only notify if vehicle subtotal ≤ FBT threshold |

All notification filters can be changed in the **Settings tab** of the dashboard without editing the file.

### Model codes
| Code | Model |
|---|---|
| `my` | Model Y |
| `m3` | Model 3 |

### Example — notify only on VIC Performance Model Y under FBT threshold

```json
{
  "notify": {
    "imessage": { "enabled": true, "to": "you@icloud.com" },
    "triggers": ["new_stock", "price_drop"],
    "filters": {
      "models": ["my"],
      "variants": ["Performance"],
      "states": ["VIC"],
      "fbtOnly": true
    }
  }
}
```

---

## CLI commands

```
node src/cli.mjs run              # One-shot check across all watches
node src/cli.mjs watch            # Repeating check loop (default: 15m)
node src/cli.mjs serve            # Start web dashboard
node src/cli.mjs test-imessage    # Send a test iMessage
node src/cli.mjs test-browser     # Verify Chrome CDP connection
node src/cli.mjs show-state       # Print current DB state
node src/cli.mjs reset-state      # Mark all vehicles removed (re-alerts on next run)

Options:
  -c, --config <path>   Config file (default: ./tesla-watch.config.json)
  -i, --interval <str>  Watch interval e.g. 5m, 15m, 1h (default: 15m)
  -p, --port <number>   Dashboard port (default: 3737)
```

---

## Web dashboard

| Tab | What's shown |
|---|---|
| Overview | Status cards per model, Australia map with inventory bubbles by state, 30-day stock chart |
| Vehicles | Searchable/filterable table — filter by model, variant, state, in stock / removed |
| Events | New stock, price drops, removals with timestamps |
| Run Log | Every checker run with status, vehicle count, and diff counts |
| Settings | iMessage config, notification filters, check frequency, advanced options |

The Australia map shows coloured bubbles (red = Model Y, blue = Model 3) sized by stock count, with hover tooltips. Selecting a state in the Overview dropdown filters the status cards to that state's inventory.

---

## launchd jobs

### `tesla-watch.plist` — inventory checker

Runs `cli.mjs run` every 5 minutes (configurable in Settings → Scheduler). Wakes the Mac from sleep. Exits after each run.

### `tesla-watch-server.plist` — web server

Runs `cli.mjs serve` continuously with `KeepAlive=true`. Restarts automatically if it crashes. Can be restarted from Settings → Scheduler → Restart server.

### Common launchctl commands

```bash
# Check status
launchctl list com.tesla-watch.checker
launchctl list com.tesla-watch.server

# Reload after editing a plist
launchctl unload ~/Library/LaunchAgents/com.tesla-watch.checker.plist
launchctl load ~/Library/LaunchAgents/com.tesla-watch.checker.plist

# View logs
tail -f data/tesla-watch.log
tail -f data/server.log
tail -f data/launchd.log
```

---

## Data

| Path | Contents |
|---|---|
| `data/tesla-watch.db` | SQLite database (watches, vehicles, events, runs) |
| `data/tesla-watch.log` | Checker run logs |
| `data/server.log` | Web server logs |
| `data/launchd.log` | launchd stdout/stderr |

The `data/` directory is gitignored. The database is created automatically on first run.

---

## Project structure

```
src/
  cli.mjs                  CLI entry point
  config.mjs               Config loader, URL builder, AU state definitions
  runner.mjs               Main check loop — collect, diff, notify, persist
  browser/
    chrome.mjs             Chrome CDP management (launch, connect, navigate)
  collectors/
    teslaInventory.mjs     API interception + DOM fallback
  db/
    database.mjs           SQLite schema, queries, upserts
  notify/
    notifier.mjs           Notification transport abstraction
    imessage.mjs           macOS iMessage via AppleScript
    filter.mjs             Notification filter logic
  parsers/
    normalizeVehicle.mjs   Raw API → normalised vehicle, ID generation, summarize
  server/
    server.mjs             Express API server
    public/
      index.html           Single-page dashboard
  state/
    diffInventory.mjs      Diff current vs prior seen IDs
    stateStore.mjs         Legacy JSON state (superseded by SQLite)
  utils/
    log.mjs                Structured logger
    retry.mjs              Retry with exponential backoff
tesla-watch.plist          launchd checker job
tesla-watch-server.plist   launchd web server job
```
