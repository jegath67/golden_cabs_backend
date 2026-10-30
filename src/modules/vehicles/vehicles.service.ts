import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';

export class VehiclesService {
  async getAllVehicles(filters?: {
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
    type?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
    status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE';
    hubId?: string;
    ownerId?: string;
    assignedVehicleId?: string;
    unassignedOnly?: boolean;
  }) {
    const ownershipConditions: any[] = [];
    if (filters?.ownerId) {
      ownershipConditions.push({ ownerId: filters.ownerId });
    }
    if (filters?.assignedVehicleId) {
      ownershipConditions.push({ id: filters.assignedVehicleId });
    }

    return prisma.vehicle.findMany({
      where: {
        ...(filters?.category ? { category: filters.category } : {}),
        ...(filters?.type ? { vehicleType: filters.type } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.hubId ? { assignedHubId: filters.hubId } : {}),
        ...(ownershipConditions.length > 1
          ? { OR: ownershipConditions }
          : ownershipConditions.length === 1
          ? ownershipConditions[0]
          : {}),
        ...(filters?.unassignedOnly ? { assignedDriver: null } : {}),
      },
      include: {
        assignedHub: true,
        assignedDriver: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        owner: {
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
        owner: {
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
    rcExpiry?: string;
    rcFront?: string;
    rcBack?: string;
    insuranceNumber?: string;
    insuranceExpiry?: string;
    insuranceDoc?: string;
    ownerId?: string;
    assignedHubId?: string;
    photos?: string[];
    vehiclePhoto?: string;
  }) {
    const photoUrls = Array.from(
      new Set([
        ...(data.photos || []),
        ...(data.vehiclePhoto ? [data.vehiclePhoto] : []),
      ])
    ).filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

    const created = await prisma.vehicle.create({
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
        rcExpiry: data.rcExpiry,
        rcFront: data.rcFront,
        rcBack: data.rcBack,
        insuranceNumber: data.insuranceNumber,
        insuranceExpiry: data.insuranceExpiry,
        insuranceDoc: data.insuranceDoc,
        ownerId: data.ownerId,
        assignedHubId: data.assignedHubId,
        ...(photoUrls.length > 0
          ? {
              photos: {
                create: photoUrls.map((url, i) => ({
                  photoUrl: url,
                  tag: i === 0 ? 'front' : 'extra',
                })),
              },
            }
          : {}),
      },
      include: {
        photos: true,
        assignedHub: true,
        owner: { select: { userId: true, user: { select: { name: true, phone: true } } } },
      },
    });

    // 1. Notify Partner/Owner if ownerId exists
    if (created.owner?.userId) {
      await notificationsService.sendToUser({
        userId: created.owner.userId,
        title: '🚙 Vehicle Submitted for Approval',
        message: `${created.brand} ${created.model} (${created.vehicleNumber}) has been submitted for admin verification.`,
        type: 'vehicle_submitted',
        data: { vehicleId: created.id, vehicleNumber: created.vehicleNumber },
        saveToDb: true,
      }).catch((err) => console.error('Error notifying partner of vehicle submission:', err));
    }

    // 2. Notify Admins
    const ownerName = created.owner?.user?.name || 'Partner';
    await notificationsService.sendToAdmins({
      title: '📋 New Vehicle Added for Verification',
      message: `${ownerName} added ${created.brand} ${created.model} (${created.vehicleNumber}). Pending approval.`,
      type: 'admin_vehicle_verification',
      data: { vehicleId: created.id, vehicleNumber: created.vehicleNumber },
    }).catch((err) => console.error('Error notifying admin of new vehicle:', err));

    return created;
  }

  async updateVehicleStatus(id: string, status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE', rejectionReason?: string) {
    const updated = await prisma.vehicle.update({
      where: { id },
      data: {
        status,
        ...(status === 'MAINTENANCE' || status === 'REJECTED' ? { isOnline: false } : {}),
      },
      include: {
        owner: { select: { userId: true } },
      },
    });

    if (updated.owner?.userId) {
      if (status === 'VERIFIED') {
        await notificationsService.sendToUser({
          userId: updated.owner.userId,
          title: '🎉 Vehicle Approved!',
          message: `Your ${updated.brand} ${updated.model} (${updated.vehicleNumber}) has been verified and approved for fleet operations.`,
          type: 'vehicle_approved',
          data: { vehicleId: updated.id, vehicleNumber: updated.vehicleNumber },
          saveToDb: true,
        }).catch((err) => console.error('Error notifying partner of vehicle verification:', err));
      } else if (status === 'REJECTED') {
        await notificationsService.sendToUser({
          userId: updated.owner.userId,
          title: '❌ Vehicle Verification Rejected',
          message: rejectionReason && rejectionReason.trim().length > 0
            ? `Your ${updated.brand} ${updated.model} (${updated.vehicleNumber}) was rejected by admin: ${rejectionReason}. Please check documents.`
            : `Your ${updated.brand} ${updated.model} (${updated.vehicleNumber}) was rejected by admin. Please check documents.`,
          type: 'vehicle_rejected',
          data: { vehicleId: updated.id, vehicleNumber: updated.vehicleNumber },
          saveToDb: true,
        }).catch((err) => console.error('Error notifying partner of vehicle rejection:', err));
      }
    }

    // Fix 1: Vehicle Deactivation ? Force assigned driver offline
    if (status === 'MAINTENANCE' || status === 'REJECTED') {
      const vehicleWithDriver = await prisma.vehicle.findUnique({
        where: { id },
        include: {
          assignedDriver: true,
        },
      });

      if (vehicleWithDriver?.assignedDriver) {
        const driverProfile = vehicleWithDriver.assignedDriver;

        // Check for active ride � ride continues safely, driver just can't go online again
        const activeRide = await prisma.ride.findFirst({
          where: {
            driverId: driverProfile.id,
            status: { in: ['SEARCHING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
          },
        });

        // Force driver offline (OFF_SHIFT) so no new rides are dispatched to them
        await prisma.driverProfile.update({
          where: { id: driverProfile.id },
          data: { isOnline: false, shiftStatus: 'OFF_SHIFT' },
        });

        // Notify driver
        if (driverProfile.userId) {
          await notificationsService.sendToUser({
            userId: driverProfile.userId,
            title: '?? Vehicle Deactivated',
            message: activeRide
              ? `Your vehicle (${updated.brand} ${updated.model}) has been deactivated by Admin. Safely complete your current trip (${activeRide.bookingCode}) then contact support.`
              : `Your vehicle (${updated.brand} ${updated.model}) has been deactivated by Admin. You have been taken offline. Please contact support.`,
            type: 'vehicle_deactivated',
            saveToDb: true,
          }).catch((err) => console.error('Error notifying driver of vehicle deactivation:', err));
        }
      }
    }

    return updated;
  }

  async toggleVehicleAvailability(vehicleId: string, isOnline: boolean) {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new Error('Vehicle not found');
    }

    if (isOnline) {
      if (vehicle.status !== 'VERIFIED') {
        throw new Error(
          `Vehicle (${vehicle.model} - ${vehicle.vehicleNumber}) is ${vehicle.status.toLowerCase()}. Only active, verified vehicles can be switched online.`
        );
      }
    }

    if (!isOnline) {
      // Check if vehicle has any active rides
      const activeRide = await prisma.ride.findFirst({
        where: {
          vehicleId: vehicle.id,
          status: { in: ['SEARCHING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
        },
      });

      if (activeRide) {
        throw new Error(
          `Cannot mark vehicle unavailable while a ride (${activeRide.bookingCode}) is currently in progress`
        );
      }
    }

    return prisma.vehicle.update({
      where: { id: vehicleId },
      data: { isOnline },
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

    // 2b. If this vehicle was previously assigned to another driver, unassign that driver first
    await prisma.driverProfile.updateMany({
      where: { assignedVehicleId: vehicleId, id: { not: driverProfileId } },
      data: { assignedVehicleId: null },
    });

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

  async getVehiclePhotos(vehicleId: string) {
    return prisma.vehiclePhoto.findMany({
      where: { vehicleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addVehiclePhoto(vehicleId: string, photoUrl: string, tag: string = 'front') {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) {
      throw new Error('Vehicle not found');
    }

    const photo = await prisma.vehiclePhoto.create({
      data: {
        vehicleId,
        photoUrl,
        tag,
      },
    });

    // Update vehiclePhoto or status for admin re-verification
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: 'PENDING',
        ...(tag === 'front' ? { vehiclePhoto: photoUrl } : {}),
      },
    });

    return photo;
  }
}

export const vehiclesService = new VehiclesService();
