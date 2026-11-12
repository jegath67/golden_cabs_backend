import { prisma } from '../../config/prisma';
import { standardizeTripType } from '../../utils/trip-type.helper';
import { platformSettingsService } from '../settings/platform-settings.service';

export function normalizeCommissionPercent(value: any, fallback = 20.0): number {
  const num = Number(value);
  if (isNaN(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num * 100) / 100));
}

export function resolveSlabVehicleType(params: {
  vehicleType?: string | null;
  carName?: string | null;
  requestedVehicle?: string | null;
  requestedSeats?: string | null;
  seatCapacity?: number | null;
  category?: string | null;
  isElite?: boolean | null;
}): string {
  const raw = [
    params.vehicleType,
    params.requestedVehicle,
    params.carName,
    params.requestedSeats,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    raw.includes('hatchback') ||
    raw.includes('swift') ||
    raw.includes('indica') ||
    raw.includes('wagon')
  ) {
    return 'Hatchback';
  }
  if (
    params.isElite ||
    String(params.category || '').toUpperCase() === 'LUXURY' ||
    String(params.category || '').toUpperCase() === 'ELITE' ||
    raw.includes('premium') ||
    raw.includes('luxury') ||
    raw.includes('elite')
  ) {
    return 'Premium';
  }
  if (
    params.seatCapacity === 6 ||
    raw.includes('6') ||
    raw.includes('suv') ||
    raw.includes('innova') ||
    raw.includes('ertiga') ||
    raw.includes('marazzo')
  ) {
    return 'SUV';
  }
  if (
    raw.includes('sedan') ||
    params.seatCapacity === 4 ||
    raw.includes('4') ||
    raw.includes('dzire') ||
    raw.includes('etios')
  ) {
    return 'Sedan';
  }
  if (String(params.category || '').toUpperCase() === 'PREMIUM') {
    return 'Premium';
  }
  return 'Sedan';
}

export function resolveSlabRideType(params: {
  customTripType?: string | null;
  tripType?: string | null;
  distanceKm?: number | null;
}): string {
  const std = standardizeTripType(params);
  switch (std) {
    case 'Local One Way':
      return 'Local Ride';
    case 'Local Round Trip':
      return 'Local Round Trip';
    case 'Outstation One Way':
      return 'Outstation One Way';
    case 'Outstation Round Trip':
      return 'Outstation Round Trip';
  }
}

export function computeCommissionSplit(grossFare: number, commissionPercent: number) {
  const safeGross = Math.max(0, Number(grossFare) || 0);
  const pct = normalizeCommissionPercent(commissionPercent, 20.0);
  const commissionAmount = Math.round(safeGross * (pct / 100) * 100) / 100;
  const driverAmount = Math.round((safeGross - commissionAmount) * 100) / 100;
  return {
    commissionPercent: pct,
    commissionAmount,
    driverAmount,
  };
}

export function resolveRideCommissionFromRecord(
  ride: {
    status?: string | null;
    paymentStatus?: string | null;
    finalFare?: number | null;
    estimatedFare?: number | null;
    fareBreakdown?: {
      totalFare?: number | null;
      baseFare?: number | null;
      discountAmount?: number | null;
      commissionPercent?: number | null;
      commissionAmount?: number | null;
      driverAmount?: number | null;
      pricingSlabId?: string | null;
    } | null;
  },
  fallbackPercent = 20.0,
  ledgerTx?: { type?: string | null; amount?: number | null } | null
) {
  const fb = ride.fareBreakdown;
  const fare = ride.finalFare ?? fb?.totalFare ?? ride.estimatedFare ?? 0;
  const discount = fb?.discountAmount ?? 0;
  const grossFare = Math.max(0, fare + discount);
  const appliedPercent = normalizeCommissionPercent(
    fb?.commissionPercent ?? fallbackPercent,
    fallbackPercent
  );

  if (ride.status === 'CANCELLED' || ride.paymentStatus === 'REFUNDED') {
    return {
      fare,
      baseFare: fb?.baseFare ?? fare,
      discount,
      grossFare,
      commissionPercent: appliedPercent,
      commissionAmount: 0,
      driverAmount: 0,
      pricingSlabId: fb?.pricingSlabId ?? null,
    };
  }

  if (fb?.commissionAmount != null && fb?.driverAmount != null) {
    return {
      fare,
      baseFare: fb?.baseFare ?? fare,
      discount,
      grossFare,
      commissionPercent: appliedPercent,
      commissionAmount: Math.round(fb.commissionAmount * 100) / 100,
      driverAmount: Math.round(fb.driverAmount * 100) / 100,
      pricingSlabId: fb?.pricingSlabId ?? null,
    };
  }

  if (ledgerTx && ledgerTx.amount != null) {
    if (ledgerTx.type === 'COMMISSION') {
      const comm = Math.round(ledgerTx.amount * 100) / 100;
      return {
        fare,
        baseFare: fb?.baseFare ?? fare,
        discount,
        grossFare,
        commissionPercent: appliedPercent,
        commissionAmount: comm,
        driverAmount: Math.round(Math.max(0, grossFare - comm) * 100) / 100,
        pricingSlabId: fb?.pricingSlabId ?? null,
      };
    }
    if (ledgerTx.type === 'EARNING') {
      const drv = Math.round(ledgerTx.amount * 100) / 100;
      return {
        fare,
        baseFare: fb?.baseFare ?? fare,
        discount,
        grossFare,
        commissionPercent: appliedPercent,
        commissionAmount: Math.round(Math.max(0, grossFare - drv) * 100) / 100,
        driverAmount: drv,
        pricingSlabId: fb?.pricingSlabId ?? null,
      };
    }
  }

  const split = computeCommissionSplit(grossFare, appliedPercent);
  return {
    fare,
    baseFare: fb?.baseFare ?? fare,
    discount,
    grossFare,
    commissionPercent: split.commissionPercent,
    commissionAmount: split.commissionAmount,
    driverAmount: split.driverAmount,
    pricingSlabId: fb?.pricingSlabId ?? null,
  };
}

export async function getLedgerTxMapForRides(rideIds: string[]) {
  const txByRideId = new Map<string, { type: string; amount: number }>();
  if (!rideIds.length) return txByRideId;

  const txs = await prisma.walletTransaction.findMany({
    where: {
      referenceRideId: { in: rideIds },
      type: { in: ['COMMISSION', 'EARNING'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const tx of txs) {
    if (tx.referenceRideId && !txByRideId.has(tx.referenceRideId)) {
      txByRideId.set(tx.referenceRideId, { type: tx.type, amount: tx.amount });
    }
  }
  return txByRideId;
}

/**
 * Authoritative Driver/Ride API fare breakdown resolver.
 * Never fabricates commission values for historical rides lacking persisted breakdown or ledger records.
 */
export function resolveDriverRideBreakdown(
  ride: {
    status?: string | null;
    paymentStatus?: string | null;
    finalFare?: number | null;
    estimatedFare?: number | null;
    distanceKm?: number | null;
    fareBreakdown?: {
      distanceKm?: number | null;
      pricePerKm?: number | null;
      baseFare?: number | null;
      tollCharge?: number | null;
      permitCharge?: number | null;
      driverBata?: number | null;
      discountAmount?: number | null;
      totalFare?: number | null;
      commissionPercent?: number | null;
      commissionAmount?: number | null;
      driverAmount?: number | null;
      pricingSlabId?: string | null;
    } | null;
  },
  ledgerTx?: { type?: string | null; amount?: number | null } | null
) {
  const fb = ride.fareBreakdown;
  const totalPayable = ride.finalFare ?? fb?.totalFare ?? ride.estimatedFare ?? 0;
  const discountAmount = fb?.discountAmount ?? 0;
  const grossFare = Math.max(0, Math.round((totalPayable + discountAmount) * 100) / 100);
  const baseFare = fb?.baseFare != null ? Math.round(fb.baseFare * 100) / 100 : null;
  const tollCharge = Math.round((fb?.tollCharge ?? 0) * 100) / 100;
  const permitCharge = Math.round((fb?.permitCharge ?? 0) * 100) / 100;
  const driverBata = Math.round((fb?.driverBata ?? 0) * 100) / 100;
  const additionalCharges = Math.round((tollCharge + permitCharge + driverBata) * 100) / 100;
  const distanceCharge =
    baseFare != null
      ? Math.max(0, Math.round((grossFare - baseFare - additionalCharges) * 100) / 100)
      : null;

  const isCancelledOrRefunded =
    ride.status === 'CANCELLED' || ride.paymentStatus === 'REFUNDED';

  const hasPersistedBreakdown =
    (fb?.commissionAmount != null && fb?.driverAmount != null) || ledgerTx != null;

  let commissionPercent: number | null =
    fb?.commissionPercent != null ? normalizeCommissionPercent(fb.commissionPercent) : null;
  let commissionAmount: number | null = null;
  let driverAmount: number | null = null;

  if (isCancelledOrRefunded) {
    commissionAmount = 0;
    driverAmount = 0;
  } else if (fb?.commissionAmount != null && fb?.driverAmount != null) {
    commissionAmount = Math.round(fb.commissionAmount * 100) / 100;
    driverAmount = Math.round(fb.driverAmount * 100) / 100;
  } else if (ledgerTx && ledgerTx.amount != null) {
    if (ledgerTx.type === 'COMMISSION') {
      commissionAmount = Math.round(ledgerTx.amount * 100) / 100;
      driverAmount = Math.round(Math.max(0, grossFare - commissionAmount) * 100) / 100;
    } else if (ledgerTx.type === 'EARNING') {
      driverAmount = Math.round(ledgerTx.amount * 100) / 100;
      commissionAmount = Math.round(Math.max(0, grossFare - driverAmount) * 100) / 100;
    }
    if (commissionPercent == null && grossFare > 0 && commissionAmount != null) {
      commissionPercent = Math.round((commissionAmount / grossFare) * 1000) / 10;
    }
  }

  return {
    hasCommissionBreakdown: hasPersistedBreakdown,
    grossFare,
    totalFare: Math.round(totalPayable * 100) / 100,
    baseFare,
    distanceKm: fb?.distanceKm ?? ride.distanceKm ?? 0,
    pricePerKm: fb?.pricePerKm ?? null,
    distanceCharge,
    tollCharge,
    permitCharge,
    driverBata,
    additionalCharges,
    discountAmount,
    commissionPercent,
    commissionAmount,
    driverAmount,
    pricingSlabId: fb?.pricingSlabId ?? null,
  };
}

export class PricingSlabsService {
  /**
   * Seed default pricing slabs if table is empty
   */
  async seedDefaultSlabsIfEmpty() {
    const count = await prisma.pricingSlab.count();
    if (count > 0) return;

    const defaultSlabs = [
      // Hatchback
      {
        vehicleType: 'Hatchback',
        rideType: 'Local Ride',
        baseFare: 150.0,
        includedKm: 5.0,
        extraKmCharge: 15.0,
        waitCharge: 2.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Hatchback',
        rideType: 'Local Round Trip',
        baseFare: 800.0,
        includedKm: 40.0,
        extraKmCharge: 14.0,
        waitCharge: 2.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Hatchback',
        rideType: 'Outstation One Way',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 14.0,
        waitCharge: 2.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Hatchback',
        rideType: 'Outstation Round Trip',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 13.0,
        waitCharge: 2.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },

      // Sedan
      {
        vehicleType: 'Sedan',
        rideType: 'Local Ride',
        baseFare: 200.0,
        includedKm: 5.0,
        extraKmCharge: 18.0,
        waitCharge: 2.5,
        nightChargeEnabled: true,
        surgePricingEnabled: true,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Sedan',
        rideType: 'Local Round Trip',
        baseFare: 1000.0,
        includedKm: 40.0,
        extraKmCharge: 16.0,
        waitCharge: 2.5,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Sedan',
        rideType: 'Outstation One Way',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 16.0,
        waitCharge: 2.5,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Sedan',
        rideType: 'Outstation Round Trip',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 15.0,
        waitCharge: 2.5,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },

      // SUV
      {
        vehicleType: 'SUV',
        rideType: 'Local Ride',
        baseFare: 250.0,
        includedKm: 5.0,
        extraKmCharge: 22.0,
        waitCharge: 3.0,
        nightChargeEnabled: true,
        surgePricingEnabled: true,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'SUV',
        rideType: 'Local Round Trip',
        baseFare: 1200.0,
        includedKm: 40.0,
        extraKmCharge: 20.0,
        waitCharge: 3.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'SUV',
        rideType: 'Outstation One Way',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 20.0,
        waitCharge: 3.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'SUV',
        rideType: 'Outstation Round Trip',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 18.0,
        waitCharge: 3.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },

      // Premium
      {
        vehicleType: 'Premium',
        rideType: 'Local Ride',
        baseFare: 350.0,
        includedKm: 5.0,
        extraKmCharge: 28.0,
        waitCharge: 4.0,
        nightChargeEnabled: true,
        surgePricingEnabled: true,
        status: 'Active',
        zone: 'All Zones',
      },
      {
        vehicleType: 'Premium',
        rideType: 'Outstation One Way',
        baseFare: 0.0,
        includedKm: 0.0,
        extraKmCharge: 28.0,
        waitCharge: 4.0,
        nightChargeEnabled: true,
        surgePricingEnabled: false,
        status: 'Active',
        zone: 'All Zones',
      },
    ];

    for (const slab of defaultSlabs) {
      await prisma.pricingSlab.create({
        data: {
          ...slab,
          commissionPercent: 20.0,
        },
      });
    }

    console.log(`[PricingSlabsService] Seeded ${defaultSlabs.length} initial pricing slabs.`);
  }

  async getAllSlabs(filters?: {
    vehicleType?: string;
    rideType?: string;
    zone?: string;
    status?: string;
  }) {
    await this.seedDefaultSlabsIfEmpty();

    const where: any = {};
    if (filters?.vehicleType && filters.vehicleType !== 'All') {
      where.vehicleType = { equals: filters.vehicleType, mode: 'insensitive' };
    }
    if (filters?.rideType && filters.rideType !== 'All') {
      where.rideType = { equals: filters.rideType, mode: 'insensitive' };
    }
    if (filters?.zone && filters.zone !== 'All Zones' && filters.zone !== 'All') {
      where.zone = { equals: filters.zone, mode: 'insensitive' };
    }
    if (filters?.status && filters.status !== 'All') {
      where.status = { equals: filters.status, mode: 'insensitive' };
    }

    const slabs = await prisma.pricingSlab.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return slabs.map((s) => ({
      ...s,
      lastUpdated: s.updatedAt.toISOString().split('T')[0],
    }));
  }

  async getSlabById(id: string) {
    const slab = await prisma.pricingSlab.findUnique({
      where: { id },
    });
    if (!slab) return null;
    return {
      ...slab,
      lastUpdated: slab.updatedAt.toISOString().split('T')[0],
    };
  }

  private validateCommissionPercent(value: any): number {
    const num = Number(value);
    if (isNaN(num)) {
      throw new Error('Commission percentage must be a valid number');
    }
    if (num < 0 || num > 100) {
      throw new Error('Commission percentage must be between 0% and 100%');
    }
    return Math.round(num * 100) / 100;
  }

  async findMatchingActiveSlab(params: {
    vehicleType?: string | null;
    carName?: string | null;
    requestedVehicle?: string | null;
    requestedSeats?: string | null;
    seatCapacity?: number | null;
    category?: string | null;
    isElite?: boolean | null;
    customTripType?: string | null;
    tripType?: string | null;
    distanceKm?: number | null;
    zone?: string | null;
  }) {
    await this.seedDefaultSlabsIfEmpty();
    const targetVehicle = resolveSlabVehicleType(params);
    const targetRideType = resolveSlabRideType(params);
    const targetZone = (params.zone || '').trim().toLowerCase();

    const activeSlabs = await prisma.pricingSlab.findMany({
      where: { status: { equals: 'Active', mode: 'insensitive' } },
      orderBy: { updatedAt: 'desc' },
    });

    const norm = (v?: string | null) => (v || '').trim().toLowerCase();

    return (
      (targetZone
        ? activeSlabs.find(
            (s) =>
              norm(s.vehicleType) === norm(targetVehicle) &&
              norm(s.rideType) === norm(targetRideType) &&
              norm(s.zone) === targetZone
          )
        : undefined) ||
      activeSlabs.find(
        (s) =>
          norm(s.vehicleType) === norm(targetVehicle) &&
          norm(s.rideType) === norm(targetRideType) &&
          norm(s.zone) === 'all zones'
      ) ||
      activeSlabs.find(
        (s) =>
          norm(s.vehicleType) === norm(targetVehicle) &&
          norm(s.rideType) === norm(targetRideType)
      ) ||
      activeSlabs.find((s) => norm(s.rideType) === norm(targetRideType)) ||
      null
    );
  }

  /**
   * Calculate customer fare & frozen commission metadata from the active matching PricingSlab.
   */
  async calculateFareFromActiveSlab(params: {
    distanceKm: number;
    vehicleType?: string | null;
    carName?: string | null;
    requestedVehicle?: string | null;
    requestedSeats?: string | null;
    seatCapacity?: number | null;
    category?: string | null;
    isElite?: boolean | null;
    customTripType?: string | null;
    tripType?: string | null;
    zone?: string | null;
    tollCharge?: number | null;
  }) {
    const match = await this.findMatchingActiveSlab(params);
    const distanceKm = Math.max(1, Number(params.distanceKm) || 1);
    const tollCharge = Math.max(0, Number(params.tollCharge) || 0);

    if (match && (match.baseFare > 0 || match.extraKmCharge > 0)) {
      const pricePerKm = match.extraKmCharge > 0 ? match.extraKmCharge : 14.0;
      const baseFare = Math.max(0, Number(match.baseFare) || 0);
      const includedKm = Math.max(0, Number(match.includedKm) || 0);
      const extraKm = baseFare > 0 ? Math.max(0, distanceKm - includedKm) : distanceKm;
      const distanceCharge = Math.round(extraKm * pricePerKm * 100) / 100;
      let subtotal = baseFare + distanceCharge;

      if (match.surgePricingEnabled && match.surgeMultiplier > 1.0) {
        subtotal = subtotal * match.surgeMultiplier;
      }

      const estimatedFare = Math.round(subtotal + tollCharge);
      return {
        matchedSlab: match,
        pricingSlabId: match.id,
        commissionPercent: normalizeCommissionPercent(match.commissionPercent, 20.0),
        distanceKm,
        includedKm,
        pricePerKm,
        baseFare,
        distanceCharge,
        tollCharge,
        driverBata: 0.0,
        estimatedFare,
      };
    }

    // Legacy fallback if no active slab matches
    let ratePerKm = 14.0;
    let baseFare = 50.0;
    const cat = String(params.category || '').toUpperCase();
    if (cat === 'PREMIUM') {
      ratePerKm = 18.0;
      baseFare = 80.0;
    } else if (cat === 'LUXURY' || cat === 'ELITE' || params.isElite) {
      ratePerKm = 24.0;
      baseFare = 150.0;
    }
    const distanceCharge = Math.round(distanceKm * ratePerKm * 100) / 100;
    const globalPct = await platformSettingsService.getCommissionPercent();

    return {
      matchedSlab: match,
      pricingSlabId: match?.id ?? null,
      commissionPercent: match
        ? normalizeCommissionPercent(match.commissionPercent, 20.0)
        : normalizeCommissionPercent(globalPct, 20.0),
      distanceKm,
      includedKm: 0,
      pricePerKm: ratePerKm,
      baseFare,
      distanceCharge,
      tollCharge,
      driverBata: 0.0,
      estimatedFare: Math.round(baseFare + distanceCharge + tollCharge),
    };
  }

  /**
   * Resolve the commission % and matching active slab for a NEW ride.
   * Only called when creating a ride (or legacy backfill) so slab edits never mutate historical rides.
   */
  async resolveSlabCommissionForNewRide(params: {
    vehicleType?: string | null;
    carName?: string | null;
    requestedVehicle?: string | null;
    requestedSeats?: string | null;
    seatCapacity?: number | null;
    category?: string | null;
    isElite?: boolean | null;
    customTripType?: string | null;
    tripType?: string | null;
    distanceKm?: number | null;
    zone?: string | null;
  }): Promise<{ commissionPercent: number; pricingSlabId: string | null }> {
    const match = await this.findMatchingActiveSlab(params);
    if (match) {
      return {
        commissionPercent: normalizeCommissionPercent(match.commissionPercent, 20.0),
        pricingSlabId: match.id,
      };
    }

    const globalPct = await platformSettingsService.getCommissionPercent();
    return {
      commissionPercent: normalizeCommissionPercent(globalPct, 20.0),
      pricingSlabId: null,
    };
  }

  async createSlab(data: any) {
    const commissionPercent =
      data.commissionPercent !== undefined && data.commissionPercent !== null
        ? this.validateCommissionPercent(data.commissionPercent)
        : await platformSettingsService.getCommissionPercent();

    const created = await prisma.pricingSlab.create({
      data: {
        vehicleType: data.vehicleType || 'Sedan',
        rideType: data.rideType || 'Local Ride',
        commissionPercent,
        baseFare: Number(data.baseFare) || 0.0,
        includedKm: Number(data.includedKm) || 0.0,
        extraKmCharge: Number(data.extraKmCharge) || 0.0,
        waitCharge: Number(data.waitCharge) || 0.0,
        nightChargeEnabled: Boolean(data.nightChargeEnabled),
        surgePricingEnabled: Boolean(data.surgePricingEnabled),
        surgeMultiplier: Number(data.surgeMultiplier) || 1.0,
        status: data.status || 'Active',
        zone: data.zone || 'All Zones',
        meta: data.meta || null,
      },
    });

    return {
      ...created,
      lastUpdated: created.updatedAt.toISOString().split('T')[0],
    };
  }

  async updateSlab(id: string, data: any) {
    const existing = await prisma.pricingSlab.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Pricing slab with id ${id} not found`);
    }

    const updatePayload: any = {};
    if (data.vehicleType !== undefined) updatePayload.vehicleType = data.vehicleType;
    if (data.rideType !== undefined) updatePayload.rideType = data.rideType;
    if (data.commissionPercent !== undefined && data.commissionPercent !== null) {
      updatePayload.commissionPercent = this.validateCommissionPercent(data.commissionPercent);
    }
    if (data.baseFare !== undefined) updatePayload.baseFare = Number(data.baseFare);
    if (data.includedKm !== undefined) updatePayload.includedKm = Number(data.includedKm);
    if (data.extraKmCharge !== undefined) updatePayload.extraKmCharge = Number(data.extraKmCharge);
    if (data.waitCharge !== undefined) updatePayload.waitCharge = Number(data.waitCharge);
    if (data.nightChargeEnabled !== undefined) updatePayload.nightChargeEnabled = Boolean(data.nightChargeEnabled);
    if (data.surgePricingEnabled !== undefined) updatePayload.surgePricingEnabled = Boolean(data.surgePricingEnabled);
    if (data.surgeMultiplier !== undefined) updatePayload.surgeMultiplier = Number(data.surgeMultiplier);
    if (data.status !== undefined) updatePayload.status = data.status;
    if (data.zone !== undefined) updatePayload.zone = data.zone;
    if (data.meta !== undefined) updatePayload.meta = data.meta;

    const updated = await prisma.pricingSlab.update({
      where: { id },
      data: updatePayload,
    });

    return {
      ...updated,
      lastUpdated: updated.updatedAt.toISOString().split('T')[0],
    };
  }

  async deleteSlab(id: string) {
    const existing = await prisma.pricingSlab.findUnique({ where: { id } });
    if (!existing) {
      throw new Error(`Pricing slab with id ${id} not found`);
    }

    await prisma.pricingSlab.delete({
      where: { id },
    });

    return { success: true, message: 'Pricing slab deleted successfully' };
  }
}

export const pricingSlabsService = new PricingSlabsService();

