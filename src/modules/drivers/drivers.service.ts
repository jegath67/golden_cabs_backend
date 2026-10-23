import { prisma } from '../../config/prisma';

export class DriversService {
  async getDriverByUserId(userId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
        wallet: true,
      },
    });

    if (!driver) return null;

    let isVehicleRequestPending = false;
    let pendingVehicleRequest = null;

    if (!driver.assignedVehicleId) {
      try {
        const pending = await prisma.$queryRawUnsafe<any[]>(
          `SELECT * FROM "VehicleRequest" WHERE "driverProfileId" = $1 AND "status" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 1`,
          driver.id
        );
        if (pending && pending.length > 0) {
          isVehicleRequestPending = true;
          pendingVehicleRequest = pending[0];
        }
      } catch (err) {
        // Table may be empty
      }
    }

    return {
      ...driver,
      isVehicleRequestPending,
      pendingVehicleRequest,
    };
  }

  async updateKycDocuments(
    userId: string,
    data: {
      name?: string;
      email?: string;
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
      vehicle?: {
        brand?: string;
        model?: string;
        year?: number;
        regNumber?: string;
        rcNumber?: string;
        rcExpiry?: string;
        rcFront?: string;
        rcBack?: string;
        insuranceNumber?: string;
        insuranceExpiry?: string;
        insuranceDoc?: string;
        seaterType?: string;
        fuelType?: string;
        gearType?: string;
        vehiclePhoto?: string;
      };
    }
  ) {
    if (data.name && data.name.trim().length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          name: data.name.trim(),
          ...(data.email && data.email.trim().length > 0 ? { email: data.email.trim() } : {}),
        },
      });
    }

    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
    });
    if (!driver) {
      throw new Error('Driver profile not found');
    }

    let assignedVehicleId: string | undefined = undefined;

    if (data.vehicle && data.vehicle.regNumber && data.vehicle.regNumber.trim().length > 0) {
      const cleanReg = data.vehicle.regNumber.trim().toUpperCase();
      const fuel = (data.vehicle.fuelType?.toUpperCase() === 'DIESEL'
        ? 'DIESEL'
        : data.vehicle.fuelType?.toUpperCase() === 'CNG'
        ? 'CNG'
        : data.vehicle.fuelType?.toUpperCase() === 'ELECTRIC'
        ? 'ELECTRIC'
        : 'PETROL') as any;
      const gear = (data.vehicle.gearType?.toUpperCase() === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL') as any;

      const existingVehicle = await prisma.vehicle.findUnique({
        where: { vehicleNumber: cleanReg },
      });

      if (existingVehicle) {
        const updated = await prisma.vehicle.update({
          where: { id: existingVehicle.id },
          data: {
            brand: data.vehicle.brand || existingVehicle.brand,
            model: data.vehicle.model || existingVehicle.model,
            year: Number(data.vehicle.year) || existingVehicle.year,
            fuelType: fuel,
            gearType: gear,
            rcNumber: data.vehicle.rcNumber || cleanReg,
            rcExpiry: data.vehicle.rcExpiry || existingVehicle.rcExpiry,
            rcFront: data.vehicle.rcFront || existingVehicle.rcFront,
            rcBack: data.vehicle.rcBack || existingVehicle.rcBack,
            insuranceNumber: data.vehicle.insuranceNumber || existingVehicle.insuranceNumber,
            insuranceExpiry: data.vehicle.insuranceExpiry || existingVehicle.insuranceExpiry,
            insuranceDoc: data.vehicle.insuranceDoc || existingVehicle.insuranceDoc,
            ownerId: driver.id,
            status: 'PENDING',
          },
        });
        assignedVehicleId = updated.id;
      } else {
        const created = await prisma.vehicle.create({
          data: {
            vehicleNumber: cleanReg,
            brand: data.vehicle.brand || 'Vehicle',
            model: data.vehicle.model || 'Model',
            year: Number(data.vehicle.year) || 2022,
            fuelType: fuel,
            gearType: gear,
            rcNumber: data.vehicle.rcNumber || cleanReg,
            rcExpiry: data.vehicle.rcExpiry,
            rcFront: data.vehicle.rcFront,
            rcBack: data.vehicle.rcBack,
            insuranceNumber: data.vehicle.insuranceNumber,
            insuranceExpiry: data.vehicle.insuranceExpiry,
            insuranceDoc: data.vehicle.insuranceDoc,
            ownerId: driver.id,
            status: 'PENDING',
          },
        });
        assignedVehicleId = created.id;
      }
    }

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
        ...(assignedVehicleId ? { assignedVehicleId } : {}),
        approvalStatus: 'PENDING', // Re-triggers pending review upon doc submission
      },
      include: {
        user: true,
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });
  }

  async toggleShift(userId: string, shiftStatus: 'ON_SHIFT' | 'OFF_SHIFT') {
    const isOnline = shiftStatus === 'ON_SHIFT';

    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { assignedVehicle: true },
    });

    if (!driver) {
      throw new Error('Driver profile not found');
    }

    if (isOnline && driver.personaType === 'DRIVE_ONLY' && !driver.assignedVehicleId) {
      throw new Error('Vehicle allocation required from Hub before starting shift and going online');
    }

    return prisma.driverProfile.update({
      where: { userId },
      data: {
        shiftStatus,
        isOnline,
      },
      include: {
        assignedVehicle: true,
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
    const list = await prisma.driverProfile.findMany({
      where: {
        ...(filters?.approvalStatus ? { approvalStatus: filters.approvalStatus } : {}),
        ...(filters?.shiftStatus ? { shiftStatus: filters.shiftStatus } : {}),
        ...(filters?.personaType ? { personaType: filters.personaType } : {}),
      },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true } },
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return list.map((d) => {
      const clean = d.id.replace(/-/g, '').toUpperCase();
      const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
      return {
        ...d,
        driverCode: `DRV-${suffix}`,
      };
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

  async requestVehicle(userId: string, notes?: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { assignedVehicle: true, assignedHub: true, user: true },
    });

    if (!driver) {
      throw new Error('Driver profile not found');
    }

    if (driver.assignedVehicleId) {
      return {
        alreadyAssigned: true,
        vehicle: driver.assignedVehicle,
        message: 'A vehicle is already allocated to your profile',
      };
    }

    const pending = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "VehicleRequest" WHERE "driverProfileId" = $1 AND "status" = 'PENDING' LIMIT 1`,
      driver.id
    ).catch(() => []);

    if (pending && pending.length > 0) {
      return {
        success: true,
        pending: true,
        message: 'Vehicle request already submitted to Hub and waiting for admin allocation',
        request: pending[0],
      };
    }

    const requestId = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "VehicleRequest" ("id", "driverProfileId", "hubId", "status", "adminNotes", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'PENDING', $4, NOW(), NOW())`,
      requestId,
      driver.id,
      driver.assignedHubId,
      notes || null
    );

    return {
      success: true,
      pending: true,
      message: 'Vehicle request submitted to Hub. Waiting for allocation.',
      requestId,
    };
  }

  async getVehicleRequests(status = 'PENDING') {
    const requests = await prisma.$queryRawUnsafe<any[]>(
      `SELECT vr.*,
              dp."id" as "driverId",
              dp."personaType",
              dp."rating",
              dp."isOnline",
              dp."approvalStatus",
              u."name" as "driverName",
              u."phone" as "driverPhone",
              h."name" as "hubName",
              v."vehicleNumber",
              v."brand",
              v."model"
       FROM "VehicleRequest" vr
       JOIN "DriverProfile" dp ON vr."driverProfileId" = dp."id"
       JOIN "User" u ON dp."userId" = u."id"
       LEFT JOIN "Hub" h ON vr."hubId" = h."id"
       LEFT JOIN "Vehicle" v ON vr."assignedVehicleId" = v."id"
       WHERE ($1 = 'ALL' OR vr."status" = $1)
       ORDER BY vr."createdAt" DESC`,
      status
    ).catch((err) => {
      console.error('Error fetching vehicle requests:', err);
      return [];
    });

    return requests;
  }
}

export const driversService = new DriversService();
