import { vehicleId } from "../parsers/normalizeVehicle.mjs";

/**
 * Compare current vehicles against prior seen IDs.
 *
 * @param {object[]} vehicles - normalized vehicles from this run
 * @param {object} seenIds - map of id -> { fields } from prior state
 * @returns {{ added: object[], removed: string[], updated: object[] }}
 */
export function diffInventory(vehicles, seenIds = {}) {
  const currentMap = {};
  for (const v of vehicles) {
    const id = vehicleId(v);
    currentMap[id] = v;
  }

  const currentSet = new Set(Object.keys(currentMap));
  const priorSet = new Set(Object.keys(seenIds));

  const added = [];
  const updated = [];

  for (const [id, v] of Object.entries(currentMap)) {
    if (!priorSet.has(id)) {
      added.push(v);
    } else {
      // Check for price change — compare as strings to avoid number/string mismatch
      const prior = seenIds[id];
      if (prior.price !== undefined && String(prior.price) !== String(v.price)) {
        updated.push({ vehicle: v, priorPrice: prior.price });
      }
    }
  }

  const removed = [...priorSet].filter((id) => !currentSet.has(id));

  return { added, removed, updated, currentMap };
}

/**
 * Convert currentMap to the seenIds format stored in state.
 * Only store the fields needed for diff comparison.
 */
export function toSeenIds(currentMap) {
  const out = {};
  for (const [id, v] of Object.entries(currentMap)) {
    out[id] = {
      price: String(v.price ?? ""),
      trim: v.trim,
      exterior: v.exterior,
      interior: v.interior,
    };
  }
  return out;
}
