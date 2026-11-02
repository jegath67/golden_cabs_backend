import { prisma } from '../../config/prisma';

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
        data: slab,
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

  async createSlab(data: any) {
    const created = await prisma.pricingSlab.create({
      data: {
        vehicleType: data.vehicleType || 'Sedan',
        rideType: data.rideType || 'Local Ride',
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

