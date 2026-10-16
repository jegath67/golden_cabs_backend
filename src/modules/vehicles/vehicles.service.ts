import { prisma } from '../../config/prisma';

export class VehiclesService {
  async getAllVehicles(filters?: {
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
    type?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
    status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE';
    hubId?: string;
  }) {
    return prisma.vehicle.findMany({
      where: {
        ...(filters?.category ? { category: filters.category } : {}),
        ...(filters?.type ? { vehicleType: filters.type } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.hubId ? { assignedHubId: filters.hubId } : {}),
      },
      include: {
        assignedHub: true,
        assignedDriver: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        photos: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getVehicleById(id: string) {
    return prisma.vehicle.findUnique({
      where: { id },
      include: {
        assignedHub: true,
        assignedDriver: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        photos: true,
      },
    });
  }

  async createVehicle(data: {
    vehicleNumber: string;
    brand: string;
    model: string;
    year: number;
    vehicleType?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
    fuelType?: 'PETROL' | 'DIESEL' | 'ELECTRIC' | 'CNG';
    gearType?: 'MANUAL' | 'AUTOMATIC';
    seatCapacity?: number;
    pricePerKm?: number;
    basePrice?: number;
    rcNumber?: string;
    insuranceNumber?: string;
    ownerId?: string;
    assignedHubId?: string;
  }) {
    return prisma.vehicle.create({
      data: {
        vehicleNumber: data.vehicleNumber.toUpperCase().trim(),
        brand: data.brand,
        model: data.model,
        year: data.year,
        vehicleType: data.vehicleType || 'SEDAN',
        category: data.category || 'BUDGET',
        fuelType: data.fuelType || 'PETROL',
        gearType: data.gearType || 'MANUAL',
        seatCapacity: data.seatCapacity || 4,
        pricePerKm: data.pricePerKm || 14.0,
        basePrice: data.basePrice || 0.0,
        rcNumber: data.rcNumber,
        insuranceNumber: data.insuranceNumber,
        ownerId: data.ownerId,
        assignedHubId: data.assignedHubId,
      },
    });
  }

  async updateVehicleStatus(id: string, status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE') {
    return prisma.vehicle.update({
      where: { id },
      data: { status },
    });
  }

  async assignVehicleToDriver(vehicleId: string, driverProfileId: string | null) {
    if (!driverProfileId) {
      // Unassign
      return prisma.vehicle.update({
        where: { id: vehicleId },
        data: {
          assignedDriver: {
            disconnect: true,
          },
        },
      });
    }

    return prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        assignedDriver: {
          connect: { id: driverProfileId },
        },
      },
    });
  }
}

export const vehiclesService = new VehiclesService();
