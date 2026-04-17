/**
 * Vehicle subtotal = TotalPrice + OrderFee (matches "Vehicle Subtotal" on tesla.com).
 */
function subtotalPrice(raw) {
  const base = raw.TotalPrice ?? raw.Price;
  if (base == null) return "";
  const orderFee = raw.OrderFee?.value ?? 0;
  return Number(base) + Number(orderFee);
}

/**
 * Drive-away price = CashDetailsByRegion[province].cash.grossPrice.
 * Falls back to TotalPrice (subtotal before government charges) if not present.
 */
function driveAwayPrice(raw) {
  const byRegion = raw.CashDetailsByRegion || {};
  // Try the vehicle's own province first, then any available region
  const province = raw.StateProvince || raw.VehicleRegion;
  const regionData = byRegion[province] || Object.values(byRegion)[0];
  const grossPrice = regionData?.cash?.grossPrice;
  if (grossPrice != null) return grossPrice;
  return raw.TotalPrice ?? raw.Price ?? "";
}

/**
 * Extract a human-readable option name from OptionCodeData by group.
 * Falls back to the raw code array value if not found.
 */
function optionName(raw, group) {
  const entry = (raw.OptionCodeData || []).find((o) => o.group === group);
  return entry?.name || entry?.description || "";
}

/**
 * Normalize a raw Tesla inventory API vehicle object into a consistent schema.
 */
export function normalizeVehicle(raw) {
  return {
    vin: raw.VIN || "",
    inventoryId: raw.Hash || "",
    // Drive-away price including all government charges (stamp duty, rego, LCT etc)
    price: driveAwayPrice(raw),
    // Vehicle subtotal before government charges — used for FBT novated lease threshold checks
    // TotalPrice + OrderFee matches "Vehicle Subtotal" on tesla.com
    subtotal: subtotalPrice(raw),
    odometer: raw.Odometer ?? "",
    trim: raw.TrimName || "",
    // Get human-readable names from OptionCodeData; fall back to raw array[0]
    wheels: optionName(raw, "WHEELS") || (raw.WHEELS?.[0] ?? ""),
    exterior: optionName(raw, "PAINT") || (raw.PAINT?.[0] ?? ""),
    interior: optionName(raw, "INTERIOR") || (raw.INTERIOR?.[0] ?? ""),
    location: raw.StateProvince || raw.VehicleRegion || "",
    city: raw.City || "",
    year: raw.Year ?? "",
    model: raw.Model || "",
    raw,
  };
}

/**
 * Generate a stable ID for a vehicle.
 * Prefers VIN, then inventory ID, then a content fingerprint.
 */
export function vehicleId(v) {
  if (v.vin) return `vin:${v.vin}`;
  if (v.inventoryId) return `id:${v.inventoryId}`;
  // Fingerprint from stable fields
  return [
    v.trim,
    v.price,
    v.odometer,
    v.exterior,
    v.interior,
    v.wheels,
    v.location,
  ]
    .map((x) => String(x || "").trim())
    .join("|");
}

/**
 * Format a vehicle into a short human-readable summary line.
 * @param {object} v - normalized vehicle
 * @param {number} [fbtThreshold] - if set, show subtotal and FBT eligibility flag
 */
export function summarize(v, fbtThreshold) {
  const driveAway = v.price !== "" ? `$${Number(v.price).toLocaleString()} drive-away` : "price n/a";

  let priceStr = driveAway;
  if (v.subtotal !== "") {
    const sub = Number(v.subtotal);
    priceStr = `$${sub.toLocaleString()} subtotal / ${driveAway}`;
    if (fbtThreshold != null) {
      priceStr += sub <= fbtThreshold ? " [FBT OK]" : ` [FBT OVER by $${(sub - fbtThreshold).toLocaleString()}]`;
    }
  }

  const parts = [
    v.year || "",
    v.trim || "Model Y",
    priceStr,
    v.odometer !== "" ? `${v.odometer}km` : "",
    v.exterior || "",
    v.interior || "",
    v.wheels || "",
    v.vin ? `VIN ${v.vin}` : "",
    [v.city, v.location].filter(Boolean).join(", ") || "",
  ].filter(Boolean);
  return `• ${parts.join(" | ")}`;
}
