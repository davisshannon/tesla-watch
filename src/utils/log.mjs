import { appendFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import path from "path";

let logFile = null;

export function setLogFile(filePath) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  logFile = filePath;
}

function ts() {
  return new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function format(level, msg, data) {
  const base = `[${ts()}] [${level}] ${msg}`;
  if (data !== undefined) {
    const extra =
      typeof data === "object" ? JSON.stringify(data) : String(data);
    return `${base} ${extra}`;
  }
  return base;
}

async function write(level, msg, data) {
  const line = format(level, msg, data);
  console.log(line);
  if (logFile) {
    await appendFile(logFile, line + "\n").catch(() => {});
  }
}

export const log = {
  info: (msg, data) => write("INFO", msg, data),
  warn: (msg, data) => write("WARN", msg, data),
  error: (msg, data) => write("ERROR", msg, data),
  debug: (msg, data) => write("DEBUG", msg, data),
};
