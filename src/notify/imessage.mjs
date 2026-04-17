import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "../utils/log.mjs";

const execFileAsync = promisify(execFile);

/**
 * Send an iMessage via AppleScript.
 * @param {string} to - phone number or iCloud email
 * @param {string} message - plain text message body
 */
export async function sendIMessage(to, message) {
  // Escape double-quotes for AppleScript string literals
  const safe = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${to}" of targetService
      send "${safe}" to targetBuddy
    end tell
  `;
  await execFileAsync("osascript", ["-e", script]);
  log.info(`iMessage sent to ${to}`);
}
