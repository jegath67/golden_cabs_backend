/**
 * Trip Type Standardization Helper
 * Ensures all trip types across Customer App, Admin Web, and Driver App
 * are strictly and consistently mapped to exactly one of:
 * - 'Local One Way'
 * - 'Local Round Trip'
 * - 'Outstation One Way'
 * - 'Outstation Round Trip'
 */

export type StandardizedTripType =
  | 'Local One Way'
  | 'Local Round Trip'
  | 'Outstation One Way'
  | 'Outstation Round Trip';

export function standardizeTripType(params: {
  customTripType?: string | null;
  tripType?: string | null;
  distanceKm?: number | null;
}): StandardizedTripType {
  const custom = (params.customTripType || '').trim().toLowerCase();

  if (custom === 'local one way' || custom === 'local oneway' || custom === 'local one-way') {
    return 'Local One Way';
  }
  if (custom === 'local round trip' || custom === 'local roundtrip' || custom === 'local round-trip') {
    return 'Local Round Trip';
  }
  if (custom === 'outstation one way' || custom === 'outstation oneway' || custom === 'outstation one-way') {
    return 'Outstation One Way';
  }
  if (custom === 'outstation round trip' || custom === 'outstation roundtrip' || custom === 'outstation round-trip') {
    return 'Outstation Round Trip';
  }

  const rawType = (params.tripType || '').toLowerCase();
  const isRound = rawType.includes('round') || custom.includes('round');
  const dist = params.distanceKm ?? 0;
  const isOutstation = dist > 25 || rawType.includes('outstation') || custom.includes('outstation');

  if (isOutstation) {
    return isRound ? 'Outstation Round Trip' : 'Outstation One Way';
  } else {
    return isRound ? 'Local Round Trip' : 'Local One Way';
  }
}
