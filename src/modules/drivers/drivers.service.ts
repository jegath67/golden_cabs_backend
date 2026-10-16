import { prisma } from '../../config/prisma';

export class DriversService {
  async getDriverByUserId(userId: string) {
    return prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
        wallet: true,
      },
    });
  }

  async updateKycDocuments(
    userId: string,
    data: {
      personaType?: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL';
      licenseNumber?: string;
      licenseExpiry?: string;
      licenseFront?: string;
      licenseBack?: string;
      aadharNumber?: string;
      aadharFront?: string;
      aadharBack?: string;
      panNumber?: string;
      panImage?: string;
      selfieImage?: string;
      assignedHubId?: string;
    }
  ) {
    return prisma.driverProfile.update({
      where: { userId },
      data: {
        ...(data.personaType ? { personaType: data.personaType } : {}),
        ...(data.licenseNumber ? { licenseNumber: data.licenseNumber } : {}),
        ...(data.licenseExpiry ? { licenseExpiry: data.licenseExpiry } : {}),
        ...(data.licenseFront ? { licenseFront: data.licenseFront } : {}),
        ...(data.licenseBack ? { licenseBack: data.licenseBack } : {}),
        ...(data.aadharNumber ? { aadharNumber: data.aadharNumber } : {}),
        ...(data.aadharFront ? { aadharFront: data.aadharFront } : {}),
        ...(data.aadharBack ? { aadharBack: data.aadharBack } : {}),
        ...(data.panNumber ? { panNumber: data.panNumber } : {}),
        ...(data.panImage ? { panImage: data.panImage } : {}),
        ...(data.selfieImage ? { selfieImage: data.selfieImage } : {}),
        ...(data.assignedHubId ? { assignedHubId: data.assignedHubId } : {}),
        approvalStatus: 'PENDING', // Re-triggers pending review upon doc submission
      },
      include: {
        assignedHub: true,
      },
    });
  }

  async toggleShift(userId: string, shiftStatus: 'ON_SHIFT' | 'OFF_SHIFT') {
    const isOnline = shiftStatus === 'ON_SHIFT';
    return prisma.driverProfile.update({
      where: { userId },
      data: {
        shiftStatus,
        isOnline,
      },
    });
  }

  async updateLocation(
    userId: string,
    data: {
      latitude: number;
      longitude: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
      rideId?: string;
    }
  ) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
    });
    if (!driver) {
      throw new Error('Driver profile not found');
    }

    if (data.rideId) {
      const ride = await prisma.ride.findUnique({
        where: { id: data.rideId },
      });
      if (!ride) {
        throw new Error('Ride not found');
      }
      if (ride.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }
      const activeStatuses = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'];
      if (!activeStatuses.includes(ride.status)) {
        throw new Error(`Cannot update ride location for inactive ride status: ${ride.status}`);
      }
    }

    const updated = await prisma.driverProfile.update({
      where: { userId },
      data: {
        currentLatitude: data.latitude,
        currentLongitude: data.longitude,
      },
      select: {
        id: true,
        currentLatitude: true,
        currentLongitude: true,
        updatedAt: true,
      },
    });

    return updated;
  }

  async selectHub(userId: string, hubId: string) {
    return prisma.driverProfile.update({
      where: { userId },
      data: { assignedHubId: hubId },
      include: { assignedHub: true },
    });
  }

  async getAllDrivers(filters?: {
    approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
    shiftStatus?: 'ON_SHIFT' | 'OFF_SHIFT';
    personaType?: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL';
  }) {
    return prisma.driverProfile.findMany({
      where: {
        ...(filters?.approvalStatus ? { approvalStatus: filters.approvalStatus } : {}),
        ...(filters?.shiftStatus ? { shiftStatus: filters.shiftStatus } : {}),
        ...(filters?.personaType ? { personaType: filters.personaType } : {}),
      },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        assignedHub: true,
        assignedVehicle: true,
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async verifyDriver(
    driverProfileId: string,
    approvalStatus: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) {
    return prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        approvalStatus,
        rejectionReason: approvalStatus === 'REJECTED' ? rejectionReason : null,
      },
      include: {
        user: true,
      },
    });
  }
}

export const driversService = new DriversService();
