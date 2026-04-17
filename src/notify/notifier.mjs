import { sendIMessage } from "./imessage.mjs";
import { log } from "../utils/log.mjs";

/**
 * Build a notifier from the notify config block.
 * Currently supports iMessage. Email/webhook can be added later.
 *
 * Usage:
 *   const notifier = buildNotifier(config.notify);
 *   await notifier.send({ title, body, items });
 */
export function buildNotifier(notifyConfig = {}) {
  const transports = [];

  if (notifyConfig?.imessage?.enabled) {
    const { to } = notifyConfig.imessage;
    if (!to) throw new Error("notify.imessage.to is required");
    transports.push(async ({ title, body, items }) => {
      const lines = [title, "", body, ...(items || [])].filter(
        (x) => x !== undefined
      );
      await sendIMessage(to, lines.join("\n"));
    });
  }

  if (transports.length === 0) {
    log.warn("No notification transports configured. Alerts will only appear in logs.");
  }

  return {
    async send(payload) {
      for (const t of transports) {
        try {
          await t(payload);
        } catch (err) {
          log.error(`Notification transport failed: ${err.message}`);
        }
      }
    },
    hasTransports: transports.length > 0,
  };
}
