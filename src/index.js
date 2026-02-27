import db from "./db.js";
import { runMonitor } from "./services/monitor.js";
import { dailySummary, rollingReport } from "./services/reporter.js";
import { runResolver } from "./services/resolver.js";
import { runTradeDiscovery } from "./services/trader.js";

function ts() {
  return new Date().toISOString();
}

function log(msg, data) {
  if (data !== undefined) console.log(`[${ts()}] ${msg}`, data);
  else console.log(`[${ts()}] ${msg}`);
}

async function runSummary() {
  const day = dailySummary(db);
  const rolling = rollingReport(db, 30);
  log("Daily summary", day);
  log("Rolling report (30d)", rolling);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const runTick = args.size === 0 || args.has("--tick");

  if (runTick) {
    log("trade discovery start");
    log("trade discovery complete", await runTradeDiscovery(db));
    log("monitor start");
    log("monitor complete", await runMonitor(db));
    log("resolver start");
    log("resolver complete", await runResolver(db));
    await runSummary();
    return;
  }

  if (args.has("--trade")) {
    log("trade discovery start");
    log("trade discovery complete", await runTradeDiscovery(db));
  }
  if (args.has("--monitor")) {
    log("monitor start");
    log("monitor complete", await runMonitor(db));
  }
  if (args.has("--resolve")) {
    log("resolver start");
    log("resolver complete", await runResolver(db));
  }
  if (args.has("--summary")) {
    await runSummary();
  }
}

main().catch((err) => {
  console.error(`[${ts()}] fatal`, err);
  process.exit(1);
});
