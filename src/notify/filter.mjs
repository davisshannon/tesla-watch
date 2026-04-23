/**
 * Apply notification filters to a list of vehicles.
 * Returns only the vehicles that should trigger an alert.
 */
export function applyFilters(vehicles, filterConfig = {}, fbtThreshold = null) {
  const { maxPrice, states, models, variants, fbtOnly } = filterConfig;
  return vehicles.filter((v) => {
    if (maxPrice != null && Number(v.price) > maxPrice) return false;
    if (states?.length && !states.includes(v.location)) return false;
    if (models?.length && !models.includes(v.model)) return false;
    if (variants?.length) {
      const trimLower = (v.trim || "").toLowerCase();
      if (!variants.some((variant) => trimLower.includes(variant.toLowerCase()))) return false;
    }
    if (fbtOnly && fbtThreshold != null && Number(v.subtotal) > fbtThreshold) return false;
    return true;
  });
}

/**
 * Apply filters to a list of { vehicle, priorPrice } updated pairs.
 */
export function applyFiltersToUpdated(updatedPairs, filterConfig = {}, fbtThreshold = null) {
  return updatedPairs.filter(({ vehicle, priorPrice }) => {
    if (Number(vehicle.price) >= Number(priorPrice)) return false;
    return applyFilters([vehicle], filterConfig, fbtThreshold).length > 0;
  });
}
