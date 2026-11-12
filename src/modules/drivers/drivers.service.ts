import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { unavailabilityService } from '../unavailability/unavailability.service';
import { normalizePhone } from '../auth/auth.service';
import { locationCacheService } from './location-cache.service';
import { vehiclesService } from '../vehicles/vehicles.service';
import { walletService } from '../wallet/wallet.service';

export class DriversService {
  async getDriverByUserId(userId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, isActive: true } },
        assignedHub: true,
        assignedVehicle: {
          include: { photos: true },
        },
        ownedVehicles: {
          include: { photos: true },
        },
        wallet: true,
      },
    });

    if (!driver) return null;

    // Layer 1: On-login / profile fetch auto-expiry check for DRIVE_ONLY drivers
    if (driver.personaType === 'DRIVE_ONLY' && driver.assignedVehicleId) {
      const expiry = await vehiclesService.checkAndExpireDriverVehicle(driver.id, {
        reason: 'profile_fetch_login',
      });
      if (expiry.unassigned) {
        driver.assignedVehicleId = null;
        driver.assignedVehicle = null;
        driver.vehicleAssignedAt = null;
        driver.vehicleExpiresAt = null;
        driver.isOnline = false;
        driver.shiftStatus = 'OFF_SHIFT';
      }
    }

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

    const clean = driver.id.replace(/-/g, '').toUpperCase();
    const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
    const driverCode = `DRV-${suffix}`;

    const attachVehiclePhotos = (v: any) => {
      if (!v) return v;
      const photoUrl = v.photos && v.photos.length > 0 ? v.photos[0].photoUrl : null;
      return {
        ...v,
        image: photoUrl,
        imageUrl: photoUrl,
        vehiclePhoto: photoUrl,
      };
    };

    const unavailableDates = await unavailabilityService.getSchedule(driver.id, driver.assignedVehicleId);

    return {
      ...driver,
      driverCode,
      unavailableDates,
      isVehicleRequestPending,
      pendingVehicleRequest,
      assignedVehicle: attachVehiclePhotos(driver.assignedVehicle),
      ownedVehicles: Array.isArray(driver.ownedVehicles)
        ? driver.ownedVehicles.map(attachVehiclePhotos)
        : [],
    };
  }

  async updateDriverProfile(
    userId: string,
    data: { name?: string; email?: string }
  ) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!driver) {
      throw new Error('Driver profile not found');
    }

    const userUpdates: { name?: string; email?: string | null } = {};

    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) throw new Error('Name cannot be empty');
      userUpdates.name = trimmed;
    }

    if (data.email !== undefined) {
      const trimmedEmail = data.email ? data.email.trim().toLowerCase() : '';
      if (trimmedEmail) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
          throw new Error('Invalid email address format');
        }
        if (trimmedEmail !== driver.user.email) {
          const existing = await prisma.user.findUnique({ where: { email: trimmedEmail } });
          if (existing && existing.id !== userId) {
            const err: any = new Error('Email is already registered with another account');
            err.statusCode = 409;
            throw err;
          }
        }
        userUpdates.email = trimmedEmail;
      } else {
        userUpdates.email = null;
      }
    }

    if (Object.keys(userUpdates).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdates,
      });
    }

    return this.getDriverByUserId(userId);
  }

  async getDriverReports(driverProfileId: string) {
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "DriverReport" (
          "id" TEXT PRIMARY KEY,
          "driverProfileId" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "category" TEXT NOT NULL,
          "description" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'In Progress',
          "response" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS "DriverReport_driverProfileId_idx" ON "DriverReport"("driverProfileId");
      `);

      const reports = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "DriverReport" WHERE "driverProfileId" = $1 ORDER BY "createdAt" DESC`,
        driverProfileId
      );
      return reports;
    } catch (error) {
      console.error('Error fetching driver reports:', error);
      return [];
    }
  }

  async createDriverReport(
    driverProfileId: string,
    data: { title: string; category: string; description: string; tripId?: string }
  ) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DriverReport" (
        "id" TEXT PRIMARY KEY,
        "driverProfileId" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "category" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'In Progress',
        "response" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "DriverReport_driverProfileId_idx" ON "DriverReport"("driverProfileId");
    `);

    const id = `REP-${Date.now().toString().slice(-4)}${Math.floor(10 + Math.random() * 90)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "DriverReport" ("id", "driverProfileId", "title", "category", "description", "status", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'In Progress', NOW(), NOW())`,
      id,
      driverProfileId,
      data.title.trim(),
      data.category.trim(),
      data.description.trim()
    );

    // Sync to SupportTicket for unified Admin Complaints Management
    try {
      const driver = await prisma.driverProfile.findUnique({
        where: { id: driverProfileId },
        include: { user: true },
      });
      if (driver?.user) {
        const uuid = crypto.randomUUID();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "SupportTicket" (
            "id", "ticketCode", "userId", "userName", "userPhone", "userRole",
            "complaintType", "category", "subject", "description", "tripId", "priority", "status", "zone", "createdAt", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, 'DRIVER', 'Driver', $6, $7, $8, $9, 'Medium', 'Open', 'Puducherry', NOW(), NOW())
          ON CONFLICT ("ticketCode") DO NOTHING`,
          uuid,
          id,
          driver.user.id,
          driver.user.name || 'Partner Driver',
          driver.user.phone || '',
          data.category.trim(),
          data.title.trim(),
          data.description.trim(),
          data.tripId || null
        );
      }
    } catch (e) {
      console.error('Error syncing driver report to SupportTicket:', e);
    }

    const created = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "DriverReport" WHERE "id" = $1`,
      id
    );
    return created[0];
  }

  async updateKycDocuments(
    userId: string,
    data: {
      name?: string;
      email?: string;
      personaType?: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL' | 'VEHICLE_ONLY';
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
      bankName?: string;
      bankAccountNumber?: string;
      bankIfsc?: string;
      bankHolderName?: string;
      bankDetails?: {
        bankName?: string;
        bankAccountNumber?: string;
        accountNo?: string;
        bankIfsc?: string;
        ifsc?: string;
        bankHolderName?: string;
        accountHolderName?: string;
      };
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
        photos?: string[];
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

      const allVehiclePhotos = Array.from(
        new Set([
          ...(data.vehicle.photos || []),
          ...(data.vehicle.vehiclePhoto ? [data.vehicle.vehiclePhoto] : []),
        ])
      ).filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

      if (allVehiclePhotos.length > 0 && assignedVehicleId) {
        for (let i = 0; i < allVehiclePhotos.length; i++) {
          const photoUrl = allVehiclePhotos[i];
          const tag = i === 0 ? 'front' : i === 1 ? 'rear' : i === 2 ? 'left' : 'right';
          const existingPhoto = await prisma.vehiclePhoto.findFirst({
            where: { vehicleId: assignedVehicleId, photoUrl },
          });
          if (!existingPhoto) {
            await prisma.vehiclePhoto.create({
              data: {
                vehicleId: assignedVehicleId,
                photoUrl,
                tag,
              },
            });
          }
        }
      }
    }

    const normalizedPersona =
      data.personaType === 'VEHICLE_ONLY' ? 'RENTAL' : data.personaType;

    const isVehicleOnly =
      normalizedPersona === 'RENTAL' ||
      data.personaType === 'VEHICLE_ONLY' ||
      driver.personaType === 'RENTAL';

    const updated = await prisma.driverProfile.update({
      where: { userId },
      data: {
        ...(normalizedPersona ? { personaType: normalizedPersona } : {}),
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
        ...(isVehicleOnly ? { assignedVehicleId: null } : assignedVehicleId ? { assignedVehicleId } : {}),
        approvalStatus: 'PENDING', // Re-triggers pending review upon doc submission
      },
      include: {
        user: true,
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });

    // Persist bank details into driver Wallet if provided during KYC onboarding
    const acctNo =
      data.bankDetails?.bankAccountNumber ||
      data.bankDetails?.accountNo ||
      data.bankAccountNumber;
    const ifscCode = data.bankDetails?.bankIfsc || data.bankDetails?.ifsc || data.bankIfsc;
    const holderName =
      data.bankDetails?.bankHolderName ||
      data.bankDetails?.accountHolderName ||
      data.bankHolderName ||
      data.name ||
      updated.user?.name;
    const bName = data.bankDetails?.bankName || data.bankName;

    if (acctNo && ifscCode && holderName) {
      await walletService.updateBankDetails(userId, {
        ...(bName ? { bankName: bName } : {}),
        bankAccountNumber: acctNo,
        bankIfsc: ifscCode,
        bankHolderName: holderName,
      });
    }

    // Notify driver of successful submission
    if (userId) {
      await notificationsService.sendToUser({
        userId,
        title: '📋 Documents Submitted for Verification',
        message: 'Your documents have been submitted to Admin. We will notify you once verified.',
        type: 'driver_documents_submitted',
        saveToDb: true,
      }).catch((err) => console.error('Error notifying driver of doc submission:', err));
    }

    // Notify Admins (Unified Single Notification for Driver + Vehicle Onboarding)
    const driverName = data.name || updated.user?.name || 'Driver';
    const driverPhone = updated.user?.phone || '';

    // Check if the driver has an owned vehicle or assigned vehicle
    const vehicle = (updated.ownedVehicles && updated.ownedVehicles.length > 0)
      ? updated.ownedVehicles[0]
      : updated.assignedVehicle;

    let adminTitle = '📋 Driver Documents Submitted';
    let adminMessage = `${driverName} (${driverPhone}) submitted documents for KYC approval.`;
    const adminData: any = { driverId: updated.id, userId: updated.userId };

    if (vehicle) {
      const vehName = `${vehicle.brand || ''} ${vehicle.model || ''}`.trim();
      const vehNum = vehicle.vehicleNumber ? ` (${vehicle.vehicleNumber})` : '';
      adminTitle = '📋 Driver & Vehicle Registration Submitted';
      adminMessage = `${driverName} (${driverPhone}) registered with ${vehName || 'Vehicle'}${vehNum} & submitted documents for approval.`;
      adminData.vehicleId = vehicle.id;
      adminData.vehicleNumber = vehicle.vehicleNumber;
      adminData.vehicleName = vehName;
    }

    await notificationsService.sendToAdmins({
      title: adminTitle,
      message: adminMessage,
      type: 'admin_driver_registered',
      data: adminData,
    }).catch((err) => console.error('Error notifying admins of driver KYC:', err));

    return updated;
  }

  async toggleShift(userId: string, shiftStatus: 'ON_SHIFT' | 'OFF_SHIFT') {
    const isOnline = shiftStatus === 'ON_SHIFT';

    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });

    if (!driver) {
      throw new Error('Driver profile not found');
    }

    if (isOnline) {
      // 1. Guard: Check if Driver User account is Active
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.isActive === false) {
        throw new Error('Your driver account has been deactivated by Admin. Please contact support.');
      }

      // 2. Guard: Check if Driver Profile is Approved
      if (driver.approvalStatus !== 'APPROVED') {
        throw new Error('Your driver profile is not approved yet.');
      }

      // Guard: Check Scheduled Unavailability for Today
      const todayDateStr = unavailabilityService.normalizeDate(new Date());
      const isTodayBlocked = await unavailabilityService.isUnavailable(
        driver.id,
        driver.assignedVehicleId,
        todayDateStr
      );
      if (isTodayBlocked) {
        throw new Error(`Cannot start shift: You or your vehicle are scheduled unavailable today (${todayDateStr}). Please clear your unavailability schedule first.`);
      }

      // 3. Guard: Check persona-specific vehicle requirements & vehicle status
      if (driver.personaType === 'DRIVE_ONLY') {
        // Layer 3 Guard: Real-time expiry check before starting shift / going online
        const expiry = await vehiclesService.checkAndExpireDriverVehicle(driver.id, {
          reason: 'shift_start_validation',
        });
        if (expiry.unassigned || !driver.assignedVehicleId || !driver.assignedVehicle) {
          throw new Error('Your daily vehicle allocation has ended. Please request a new vehicle from the Hub before starting your shift.');
        }
        if (driver.assignedVehicle.status !== 'VERIFIED') {
          throw new Error(`Assigned vehicle (${driver.assignedVehicle.model}) is ${driver.assignedVehicle.status.toLowerCase()} and cannot be used to start a shift. Please contact support.`);
        }
      } else if (driver.personaType === 'OWN_VEHICLE') {
        const verifiedOwned = driver.ownedVehicles?.find((v) => v.status === 'VERIFIED');
        const hasVerifiedAssigned = driver.assignedVehicle && driver.assignedVehicle.status === 'VERIFIED';
        if (!hasVerifiedAssigned && !verifiedOwned) {
          throw new Error('Approved and verified personal vehicle required before starting shift and going online');
        }
        if (!driver.assignedVehicleId && verifiedOwned) {
          await prisma.driverProfile.update({
            where: { id: driver.id },
            data: { assignedVehicleId: verifiedOwned.id },
          });
        }
      } else if (driver.personaType === 'RENTAL') {
        if (!driver.assignedVehicleId || !driver.assignedVehicle) {
          throw new Error('Active rental vehicle allocation required before starting shift and going online');
        }
        if (driver.assignedVehicle.status !== 'VERIFIED') {
          throw new Error(`Rental vehicle (${driver.assignedVehicle.model}) is ${driver.assignedVehicle.status.toLowerCase()} and cannot be used to start a shift. Please contact support.`);
        }
      }
    }

    const updatedProfile = await prisma.driverProfile.update({
      where: { userId },
      data: {
        shiftStatus,
        isOnline,
      },
      include: {
        assignedVehicle: true,
      },
    });

    if (!isOnline) {
      // Flush location to PostgreSQL immediately when going offline
      locationCacheService.flushDriverImmediately(driver.id).catch(() => {});
    }

    return updatedProfile;
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
      clientTimestamp?: number;
      timestamp?: number;
    }
  ) {
    // P2 Optimization: Multi-tier cached resolution of driverProfile.id from userId
    const driverId = await locationCacheService.getDriverIdForUser(userId);

    // P2 Optimization: Multi-tier cached validation of active ride ownership and status
    if (data.rideId) {
      await locationCacheService.validateActiveRide(data.rideId, driverId);
    }

    // Save to Redis / In-Memory cache and schedule periodic batch dump to PostgreSQL
    const cached = await locationCacheService.saveDriverLocation(driverId, {
      userId,
      latitude: data.latitude,
      longitude: data.longitude,
      heading: data.heading,
      speed: data.speed,
      accuracy: data.accuracy,
      rideId: data.rideId,
      clientTimestamp: data.clientTimestamp ?? data.timestamp,
    });

    return {
      id: driverId,
      currentLatitude: cached.latitude,
      currentLongitude: cached.longitude,
      updatedAt: new Date(cached.updatedAt),
    };
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
    personaType?: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL' | 'VEHICLE_ONLY';
  }) {
    const personaFilter =
      filters?.personaType === 'VEHICLE_ONLY' ? 'RENTAL' : filters?.personaType;

    const list = await prisma.driverProfile.findMany({
      where: {
        ...(filters?.approvalStatus ? { approvalStatus: filters.approvalStatus } : {}),
        ...(filters?.shiftStatus ? { shiftStatus: filters.shiftStatus } : {}),
        ...(personaFilter ? { personaType: personaFilter } : {}),
      },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, isActive: true } },
        assignedHub: true,
        assignedVehicle: {
          include: { photos: true },
        },
        ownedVehicles: {
          include: { photos: true },
        },
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const attachVehiclePhotos = (v: any) => {
      if (!v) return v;
      const photoUrl = v.photos && v.photos.length > 0 ? v.photos[0].photoUrl : null;
      return {
        ...v,
        image: photoUrl,
        imageUrl: photoUrl,
        vehiclePhoto: photoUrl,
      };
    };

    // Pre-fetch all unavailability records in one quick query
    const unavailMap: Record<string, string[]> = {};
    try {
      const allSchedules = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "driverId", "vehicleId", "date" FROM "UnavailabilitySchedule" ORDER BY "date" ASC`
      );
      for (const row of allSchedules) {
        if (row.driverId) {
          if (!unavailMap[row.driverId]) unavailMap[row.driverId] = [];
          if (!unavailMap[row.driverId].includes(row.date)) unavailMap[row.driverId].push(row.date);
        }
        if (row.vehicleId) {
          if (!unavailMap[row.vehicleId]) unavailMap[row.vehicleId] = [];
          if (!unavailMap[row.vehicleId].includes(row.date)) unavailMap[row.vehicleId].push(row.date);
        }
      }
    } catch (_) {}

    return list.map((d) => {
      const clean = d.id.replace(/-/g, '').toUpperCase();
      const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
      const driverDates = unavailMap[d.id] || [];
      const vehicleDates = d.assignedVehicleId ? (unavailMap[d.assignedVehicleId] || []) : [];
      const unavailableDates = Array.from(new Set([...driverDates, ...vehicleDates])).sort();

      return {
        ...d,
        driverCode: `DRV-${suffix}`,
        unavailableDates,
        assignedVehicle: attachVehiclePhotos(d.assignedVehicle),
        ownedVehicles: Array.isArray(d.ownedVehicles)
          ? d.ownedVehicles.map(attachVehiclePhotos)
          : [],
      };
    });
  }

  async verifyDriver(
    driverProfileId: string,
    approvalStatus: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) {
    const driver = await prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: {
        approvalStatus,
        rejectionReason: approvalStatus === 'REJECTED' ? rejectionReason : null,
      },
      include: {
        user: true,
      },
    });

    if (approvalStatus === 'APPROVED') {
      await prisma.vehicle.updateMany({
        where: {
          OR: [
            { ownerId: driverProfileId },
            ...(driver.assignedVehicleId ? [{ id: driver.assignedVehicleId }] : []),
          ],
        },
        data: {
          status: 'VERIFIED',
          ownerId: driverProfileId,
        },
      });

      if (driver.userId) {
        await notificationsService.sendToUser({
          userId: driver.userId,
          title: '✅ Profile Verified & Approved',
          message: 'Congratulations! Your driver account has been verified. You can now go online and accept rides.',
          type: 'driver_approved',
          saveToDb: true,
        }).catch((err) => console.error('Error notifying driver of approval:', err));
      }
    } else if (approvalStatus === 'REJECTED') {
      if (driver.userId) {
        await notificationsService.sendToUser({
          userId: driver.userId,
          title: '❌ Verification Rejected',
          message: rejectionReason
            ? `Your verification was rejected: ${rejectionReason}. Please update documents in Account screen.`
            : 'Your verification was rejected. Please re-upload your documents in Account screen.',
          type: 'driver_rejected',
          saveToDb: true,
        }).catch((err) => console.error('Error notifying driver of rejection:', err));
      }
    }

    return driver;
  }

  async updateDriverStatus(driverProfileId: string, status: 'ACTIVE' | 'INACTIVE') {
    const driver = await prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      include: { user: true, assignedVehicle: true },
    });
    if (!driver) {
      throw new Error('Driver profile not found');
    }

    const isActive = status === 'ACTIVE';

    // 1. Update user account active state
    if (driver.userId) {
      await prisma.user.update({
        where: { id: driver.userId },
        data: { isActive },
      });
    }

    // 2. If deactivated, handle active ride protection & force driver offline
    let updatedProfile = driver;
    if (!isActive) {
      // Fix 6: Check for ongoing active ride before deactivation
      const activeRide = await prisma.ride.findFirst({
        where: {
          driverId: driverProfileId,
          status: { in: ['SEARCHING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
        },
      });

      // Put driver OFF_SHIFT and offline so no NEW rides can be dispatched
      // Active ongoing ride is NOT cancelled; driver can complete the trip safely.
      updatedProfile = await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: {
          isOnline: false,
          shiftStatus: 'OFF_SHIFT',
        },
        include: { user: true, assignedVehicle: true },
      });

      // Also set assigned vehicle offline if any
      if (driver.assignedVehicleId) {
        await prisma.vehicle.update({
          where: { id: driver.assignedVehicleId },
          data: { isOnline: false },
        }).catch(() => {});
      }

      // Notify driver with active ride context
      if (driver.userId) {
        await notificationsService.sendToUser({
          userId: driver.userId,
          title: activeRide ? '⚠️ Account Deactivated – Complete Current Trip' : '🚫 Account Deactivated',
          message: activeRide
            ? `Admin has deactivated your account. Please safely complete your current trip (${activeRide.bookingCode}) and contact support.`
            : 'Your driver account has been deactivated by Admin. Please contact support.',
          type: 'account_deactivated',
          saveToDb: true,
        }).catch((err) => console.error('Error notifying driver of deactivation:', err));
      }
    }

    return updatedProfile;
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

    // Unavailability Guard: Cannot request vehicle if driver is marked unavailable today
    const todayStr = unavailabilityService.normalizeDate(new Date());
    const isTodayBlocked = await unavailabilityService.isUnavailable(driver.id, null, todayStr);
    if (isTodayBlocked) {
      throw new Error(`Cannot request a vehicle: You are scheduled unavailable today (${todayStr}). Please clear your unavailability schedule first.`);
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

    // 1. Notify Driver in App Inbox
    if (driver.userId) {
      await notificationsService.sendToUser({
        userId: driver.userId,
        title: '🚗 Vehicle Request Submitted',
        message: 'Your vehicle request has been sent to Hub Manager. Waiting for allocation.',
        type: 'vehicle_request',
        data: { requestId, status: 'PENDING' },
        saveToDb: true,
      }).catch((err) => console.error('Error sending driver vehicle request notification:', err));
    }

    // 2. Notify Admins
    const driverName = driver.user?.name || 'Driver';
    const driverPhone = driver.user?.phone || '';
    await notificationsService.sendToAdmins({
      title: '🚗 New Vehicle Request',
      message: `${driverName} (${driverPhone}) requested a vehicle from Hub.`,
      type: 'admin_vehicle_request',
      data: { driverId: driver.id, requestId },
    }).catch((err) => console.error('Error notifying admin of vehicle request:', err));

    return {
      success: true,
      pending: true,
      message: 'Vehicle request submitted to Hub. Waiting for allocation.',
      requestId,
    };
  }

  async cancelVehicleRequest(requestId: string, adminReason?: string, driverId?: string) {
    const rawId = String(requestId).trim();

    // 1. Try finding by VehicleRequest id
    let reqs = await prisma.$queryRawUnsafe<any[]>(
      `SELECT vr.*, dp."userId"
       FROM "VehicleRequest" vr
       JOIN "DriverProfile" dp ON vr."driverProfileId" = dp."id"
       WHERE vr."id" = $1 LIMIT 1`,
      rawId
    ).catch(() => []);

    // 2. If not found by VehicleRequest id, check if rawId is a Notification id
    if (!reqs || reqs.length === 0) {
      const notif = await prisma.notification.findUnique({ where: { id: rawId } }).catch(() => null);
      if (notif && notif.data) {
        let nData: any = notif.data;
        if (typeof nData === 'string') {
          try { nData = JSON.parse(nData); } catch (_) {}
        }
        const extractedReqId = nData?.requestId || nData?.request_id;
        const extractedDriverId = nData?.driverId || nData?.driver_id;

        if (extractedReqId) {
          reqs = await prisma.$queryRawUnsafe<any[]>(
            `SELECT vr.*, dp."userId"
             FROM "VehicleRequest" vr
             JOIN "DriverProfile" dp ON vr."driverProfileId" = dp."id"
             WHERE vr."id" = $1 LIMIT 1`,
            extractedReqId
          ).catch(() => []);
        }

        if ((!reqs || reqs.length === 0) && extractedDriverId) {
          reqs = await prisma.$queryRawUnsafe<any[]>(
            `SELECT vr.*, dp."userId"
             FROM "VehicleRequest" vr
             JOIN "DriverProfile" dp ON vr."driverProfileId" = dp."id"
             WHERE vr."driverProfileId" = $1 AND vr."status" = 'PENDING'
             ORDER BY vr."createdAt" DESC LIMIT 1`,
            extractedDriverId
          ).catch(() => []);
        }
      }
    }

    // 3. If still not found, check if rawId or driverId matches a driver's pending request
    const effectiveDriverId = driverId || rawId;
    if (!reqs || reqs.length === 0) {
      reqs = await prisma.$queryRawUnsafe<any[]>(
        `SELECT vr.*, dp."userId"
         FROM "VehicleRequest" vr
         JOIN "DriverProfile" dp ON vr."driverProfileId" = dp."id"
         WHERE vr."driverProfileId" = $1 AND vr."status" = 'PENDING'
         ORDER BY vr."createdAt" DESC LIMIT 1`,
        effectiveDriverId
      ).catch(() => []);
    }

    if (!reqs || reqs.length === 0) {
      throw new Error(`Vehicle request not found for ID: ${rawId}`);
    }

    const targetReq = reqs[0];
    const targetRequestId = targetReq.id;

    if (targetReq.status === 'CANCELLED') {
      return { success: true, message: 'Vehicle request is already cancelled', requestId: targetRequestId };
    }

    const reason = adminReason?.trim() || 'Cancelled by Admin';

    await prisma.$executeRawUnsafe(
      `UPDATE "VehicleRequest" 
       SET "status" = 'CANCELLED', "adminNotes" = $1, "updatedAt" = NOW() 
       WHERE "id" = $2`,
      reason,
      targetRequestId
    );

    // Also mark any admin notification for this request as read and set status to CANCELLED in data JSON
    await prisma.$executeRawUnsafe(
      `UPDATE "Notification" 
       SET "isRead" = true,
           "data" = jsonb_set(COALESCE("data"::jsonb, '{}'::jsonb), '{status}', '"CANCELLED"')
       WHERE "data"->>'requestId' = $1 
          OR "data"->>'request_id' = $1 
          OR "id" = $2`,
      targetRequestId,
      rawId
    ).catch(() => {});

    // Notify Driver in App Inbox
    if (targetReq.userId) {
      await notificationsService.sendToUser({
        userId: targetReq.userId,
        title: 'Vehicle Request Cancelled',
        message: adminReason?.trim() 
          ? `Your vehicle request was cancelled: ${adminReason.trim()}`
          : 'Your vehicle request has been cancelled by Admin. You may submit a new request if needed.',
        type: 'vehicle_request_cancelled',
        data: { requestId: targetRequestId, status: 'CANCELLED' },
        saveToDb: true,
      }).catch((err) => console.error('Error sending driver cancellation notification:', err));
    }

    return {
      success: true,
      message: 'Vehicle request cancelled successfully',
      requestId: targetRequestId,
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

    return requests.map((r) => {
      const clean = (r.driverId || '').replace(/-/g, '').toUpperCase();
      const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
      return {
        ...r,
        driverCode: `DRV-${suffix}`,
      };
    });
  }

  async createDriver(data: {
    name: string;
    phone: string;
    email?: string;
    personaType?: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL';
    licenseNumber?: string;
    licenseExpiry?: string;
    aadharNumber?: string;
    panNumber?: string;
    assignedHubId?: string;
  }) {
    const cleanPhone = normalizePhone(data.phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Valid 10-digit phone number is required');
    }
    if (!data.name || data.name.trim().length === 0) {
      throw new Error('Name is required');
    }

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
        ],
      },
      include: { driverProfile: true },
    });

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          phone: cleanPhone,
          name: data.name.trim(),
          role: 'DRIVER',
          isActive: true,
          ...(data.email ? { email: data.email.trim().toLowerCase() } : {}),
        },
        include: { driverProfile: true },
      });
    } else {
      user = await prisma.user.create({
        data: {
          phone: cleanPhone,
          name: data.name.trim(),
          email: data.email?.trim().toLowerCase() || null,
          role: 'DRIVER',
          isActive: true,
        },
        include: { driverProfile: true },
      });
    }

    let profile = user.driverProfile;
    const persona = data.personaType || 'DRIVE_ONLY';

    if (!profile) {
      profile = await prisma.driverProfile.create({
        data: {
          userId: user.id,
          personaType: persona,
          licenseNumber: data.licenseNumber,
          licenseExpiry: data.licenseExpiry,
          aadharNumber: data.aadharNumber,
          panNumber: data.panNumber,
          assignedHubId: data.assignedHubId,
          approvalStatus: 'APPROVED',
          wallet: {
            create: { balance: 0 },
          },
        },
      });
    } else {
      profile = await prisma.driverProfile.update({
        where: { id: profile.id },
        data: {
          personaType: persona,
          approvalStatus: 'APPROVED',
          licenseNumber: data.licenseNumber || profile.licenseNumber,
          licenseExpiry: data.licenseExpiry || profile.licenseExpiry,
          aadharNumber: data.aadharNumber || profile.aadharNumber,
          panNumber: data.panNumber || profile.panNumber,
          assignedHubId: data.assignedHubId || profile.assignedHubId,
        },
      });
    }

    return prisma.driverProfile.findUnique({
      where: { id: profile.id },
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, isActive: true } },
        assignedHub: true,
        assignedVehicle: true,
        ownedVehicles: true,
        wallet: true,
      },
    });
  }
}

export const driversService = new DriversService();
