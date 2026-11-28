/**
 * Ride & Vehicle Category Helpers
 * Ensures consistent Elite vs Budget/Regular classification across
 * booking creation, fare estimation, availability checks, admin display,
 * notifications, and scheduler auto-dispatch.
 */

export function resolveRideIsElite(params: {
  isElite?: unknown;
  category?: unknown;
  requestedVehicle?: unknown;
  carName?: unknown;
  tripType?: unknown;
}): boolean {
  const categoryUpper = String(params.category ?? '').trim().toUpperCase();
  if (params.isElite === false || categoryUpper === 'BUDGET') {
    return false;
  }

  return !!(
    params.isElite === true ||
    categoryUpper === 'ELITE' ||
    categoryUpper === 'LUXURY' ||
    String(params.requestedVehicle ?? '').toLowerCase().includes('elite') ||
    String(params.carName ?? '').toLowerCase().includes('elite') ||
    String(params.tripType ?? '').toLowerCase().includes('elite')
  );
}

export function isVehicleLuxury(
  vehicle?: { category?: unknown; vehicleType?: unknown } | null
): boolean {
  if (!vehicle) return false;
  const cat = String(vehicle.category ?? '').trim().toUpperCase();
  const type = String(vehicle.vehicleType ?? '').trim().toUpperCase();
  return cat === 'LUXURY' || cat === 'ELITE' || type === 'LUXURY' || type === 'ELITE';
}
