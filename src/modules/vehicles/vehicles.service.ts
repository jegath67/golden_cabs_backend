import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';

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
      // Unassign driver from vehicle
      const existingVehicle = await prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: {
          assignedDriver: {
            include: { user: true },
          },
        },
      });

      if (existingVehicle?.assignedDriver) {
        // Automatically put driver off shift when vehicle is unassigned
        await prisma.driverProfile.update({
          where: { id: existingVehicle.assignedDriver.id },
          data: {
            isOnline: false,
            shiftStatus: 'OFF_SHIFT',
          },
        });

        // Send notification to the driver
        if (existingVehicle.assignedDriver.userId) {
          await notificationsService.sendToUser({
            userId: existingVehicle.assignedDriver.userId,
            title: '🚗 Vehicle De-allocated',
            message: `${existingVehicle.brand} ${existingVehicle.model} (${existingVehicle.vehicleNumber}) has been unassigned. Please request a new vehicle from Hub to go online.`,
            type: 'vehicle_unassignment',
            data: {
              vehicleId: existingVehicle.id,
              vehicleNumber: existingVehicle.vehicleNumber,
            },
            saveToDb: true,
          }).catch((err) => console.error('Error notifying driver of unassignment:', err));
        }
      }

      return prisma.vehicle.update({
        where: { id: vehicleId },
        data: {
          assignedDriver: {
            disconnect: true,
          },
        },
      });
    }

    // 1. Fetch target driver
    const driver = await prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      include: {
        user: true,
        assignedVehicle: true,
      },
    });

    if (!driver) {
      throw new Error('Driver profile not found');
    }

    // 2. If driver was previously assigned to a different vehicle, disconnect that old vehicle
    if (driver.assignedVehicleId && driver.assignedVehicleId !== vehicleId) {
      await prisma.vehicle.update({
        where: { id: driver.assignedVehicleId },
        data: {
          assignedDriver: {
            disconnect: true,
          },
        },
      });
    }

    // 3. Connect this vehicle to the driver
    const updated = await prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        assignedDriver: {
          connect: { id: driverProfileId },
        },
      },
      include: {
        assignedDriver: {
          include: {
            user: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    // 4. Mark any pending VehicleRequest for this driver as ASSIGNED
    await prisma.$executeRawUnsafe(
      `UPDATE "VehicleRequest" SET "status" = 'ASSIGNED', "assignedVehicleId" = $1, "updatedAt" = NOW() WHERE "driverProfileId" = $2 AND "status" = 'PENDING'`,
      vehicleId,
      driverProfileId
    ).catch((err) => console.error('Error updating VehicleRequest status:', err));

    // 5. Send push notification & in-app inbox notification to the driver
    if (driver.userId) {
      await notificationsService.sendToUser({
        userId: driver.userId,
        title: '🚗 Vehicle Assigned!',
        message: `${updated.brand} ${updated.model} (${updated.vehicleNumber}) has been allocated to you. You can now go online.`,
        type: 'vehicle_assignment',
        data: {
          vehicleId: updated.id,
          vehicleNumber: updated.vehicleNumber,
          vehicleName: `${updated.brand} ${updated.model}`,
        },
        saveToDb: true,
      }).catch((err) => console.error('Error notifying driver of assignment:', err));
    }

    return updated;
  }
}

export const vehiclesService = new VehiclesService();
