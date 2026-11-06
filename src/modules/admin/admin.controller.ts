import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../config/prisma';
import { standardizeTripType } from '../../utils/trip-type.helper';
import { driverAvailabilityService } from '../rides/driver-availability.service';
import { platformSettingsService } from '../settings/platform-settings.service';
import { locationCacheService } from '../drivers/location-cache.service';

function formatDriverCode(driverId?: string | null): string | null {
  if (!driverId) return null;
  const clean = driverId.replace(/^DRV-/i, '').replace(/-/g, '').toUpperCase();
  const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
  return `DRV-${suffix}`;
}

function formatCustomerCode(userId?: string | null): string {
  if (!userId) return 'CUST-00000';
  const clean = String(userId).replace(/^CUST-/i, '').replace(/-/g, '').toUpperCase();
  const suffix = clean.length >= 5 ? clean.slice(-5) : clean.padStart(5, '0');
  return `CUST-${suffix}`;
}

export function formatAdminCode(adminId?: string | null): string {
  if (!adminId) return 'ADM-00001';
  const clean = String(adminId).replace(/^(GC-)?ADM-/i, '').replace(/-/g, '').toUpperCase();
  const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
  return `ADM-${suffix}`;
}

function formatRideResponse(r: any) {
  const meta = (r.stops as any) || {};
  const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;

  let displayStatus = 'New Request';
  const cancelReasonLower = (r.cancelReason || '').toLowerCase();
  const isAutoExpired = isScheduled && (
    cancelReasonLower.includes('30 minutes') ||
    cancelReasonLower.includes('expired') ||
    cancelReasonLower.includes('auto-cancel')
  );

  const isPendingOver30Mins = isScheduled && !r.driverId && r.status === 'SEARCHING' && r.createdAt && (Date.now() - new Date(r.createdAt).getTime()) >= 30 * 60 * 1000;

  if (isAutoExpired || isPendingOver30Mins) {
    displayStatus = 'TIME EXPIRED';
  } else if (isScheduled && !r.driverId && r.status === 'SEARCHING') {
    displayStatus = 'Scheduled';
  } else if (r.status === 'SEARCHING') {
    displayStatus = r.driverId ? 'Assigned' : 'New Request';
  } else if (r.status === 'ACCEPTED') {
    displayStatus = 'Accepted';
  } else if (['EN_ROUTE', 'ARRIVED', 'ONGOING'].includes(r.status)) {
    displayStatus = 'Ongoing';
  } else if (r.status === 'COMPLETED') {
    displayStatus = 'Completed';
  } else if (r.status === 'CANCELLED') {
    displayStatus = 'Cancelled';
  }

  const tripType = standardizeTripType({
    customTripType: meta.customTripType,
    tripType: r.tripType,
    distanceKm: r.distanceKm,
  });
  const isElite = !!(
    meta.isElite ||
    meta.category === 'ELITE' ||
    meta.requestedVehicle?.toLowerCase().includes('elite') ||
    r.tripType?.toLowerCase().includes('elite')
  );

  const fareNum = r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0;
  const distNum = r.distanceKm ?? 0;

  let scheduledDateStr = meta.scheduledDisplay ? String(meta.scheduledDisplay) : '';
  if (!scheduledDateStr && meta.scheduledAt) {
    const sDate = new Date(meta.scheduledAt);
    if (!isNaN(sDate.getTime())) {
      scheduledDateStr = sDate.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      }) + ', ' + sDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata',
      });
    } else {
      scheduledDateStr = String(meta.scheduledAt);
    }
  }
  const createdDateStr = r.createdAt ? r.createdAt.toISOString().replace('T', ' ').substring(0, 16) : '';
  const finalDatetime = scheduledDateStr || createdDateStr;

  const seatCap = meta.seatCapacity ? String(meta.seatCapacity) : (meta.requestedVehicle?.includes('6') ? '6' : '4');
  const reqVehicle = meta.requestedVehicle || (seatCap === '6' ? '6 Seater Cab' : '4 Seater Cab');

  const rawDriverId = r.driver?.id || r.driverId || null;
  const driverCode = formatDriverCode(rawDriverId);

  // Extract real assigned vehicle information
  const vehicleObj = r.vehicle || r.driver?.assignedVehicle || null;
  const assignedVehicleNumber = vehicleObj?.vehicleNumber || null;
  const assignedVehicleModel = vehicleObj?.model || vehicleObj?.brand || null;

  return {
    id: r.id,
    bookingId: r.bookingCode || r.id,
    type: tripType,
    isElite,
    category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
    datetime: finalDatetime,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    isScheduled,
    scheduledAt: meta.scheduledAt ? String(meta.scheduledAt) : null,
    status: displayStatus,
    dbStatus: r.status,
    isDriverAccepted: r.status === 'ACCEPTED' || ['EN_ROUTE', 'ARRIVED', 'ONGOING', 'COMPLETED'].includes(r.status),
    customerId: r.customer?.id || r.customerId,
    customerName: r.customer?.name || 'Customer',
    customerPhone: r.customer?.phone || '',
    requestedVehicleId: reqVehicle,
    requestedSeatCount: seatCap,
    assignedDriverId: rawDriverId,
    assignedDriverCode: driverCode,
    assignedDriverName: r.driver?.user?.name || null,
    assignedDriverPhone: r.driver?.user?.phone || null,
    assignedVehicleId: r.vehicleId || r.driver?.assignedVehicleId || null,
    assignedVehicleNumber,
    assignedVehicleModel,
    pickup: r.pickupAddress || r.pickupLocation,
    drop: r.dropAddress || r.dropLocation,
    fare: `₹ ${Math.round(fareNum)}`,
    fareAmount: fareNum,
    distance: `${distNum} km`,
    distanceKm: distNum,
    pickupLat: r.pickupLat,
    pickupLng: r.pickupLng,
    dropLat: r.dropLat,
    dropLng: r.dropLng,
    driverLat: r.driver?.currentLatitude ?? null,
    driverLng: r.driver?.currentLongitude ?? null,
    driverLocationUpdatedAt: r.driver?.updatedAt ? r.driver.updatedAt.toISOString() : null,
    startOtp: r.startOtp,
    isLive: ['SEARCHING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'].includes(r.status),
    assignmentMode: 'Manual',
    cancelReason: r.cancelReason || null,
    cancelledBy: r.cancelledBy || null,
    cancelledAt: r.status === 'CANCELLED' ? (r.updatedAt ? r.updatedAt.toISOString() : null) : null,
    stops: Array.isArray(meta.additionalStops)
      ? meta.additionalStops
      : (Array.isArray(meta.stops) ? meta.stops : []),
    dispatchTimeline: [
      {
        time: r.createdAt ? r.createdAt.toTimeString().substring(0, 5) : '',
        event: 'Ride Created',
      },
    ],
  };
}

export class AdminController {
  /**
   * List all registered customers with profile and ride counts
   */
  async getCustomers(req: FastifyRequest, reply: FastifyReply) {
    try {
      const customers = await prisma.user.findMany({
        where: { role: 'CUSTOMER' },
        include: {
          customerProfile: true,
          _count: {
            select: { ridesAsCustomer: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const formatted = customers.map((u) => {
        const regDate = u.createdAt ? u.createdAt.toISOString().split('T')[0] : '';
        const lastActiveDate = u.updatedAt ? u.updatedAt.toISOString().replace('T', ' ').substring(0, 16) : '';

        return {
          id: u.id,
          customerCode: formatCustomerCode(u.id),
          name: u.name || 'Customer',
          phone: u.phone,
          email: u.email || '',
          zone: 'Puducherry',
          address: u.customerProfile?.address || '',
          registrationDate: regDate,
          lastActive: lastActiveDate,
          status: u.isActive ? 'Active' : 'Inactive',
          totalRides: u._count?.ridesAsCustomer ?? u.customerProfile?.totalRides ?? 0,
          totalSpent: 0.0,
          averageRating: u.customerProfile?.rating ?? 5.0,
          preferredPayment: 'Cash/UPI',
          emergencyContact: u.customerProfile?.emergencyContact || '',
          dateOfBirth: u.customerProfile?.dob || '',
          gender: u.customerProfile?.gender || '',
        };
      });

      return reply.send({
        success: true,
        data: formatted,
        count: formatted.length,
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to retrieve customers',
        error: String(error),
      });
    }
  }

  /**
   * Get single customer by ID
   */
  async getCustomerById(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };

    try {
      const cleanId = String(id).trim();
      const isCustCode = cleanId.toUpperCase().startsWith('CUST-');
      const suffix = isCustCode ? cleanId.substring(5).replace(/-/g, '').toLowerCase() : null;

      const customer = await prisma.user.findFirst({
        where: {
          role: 'CUSTOMER',
          ...(isCustCode
            ? { id: { endsWith: suffix! } }
            : { id: cleanId }),
        },
        include: {
          customerProfile: true,
          _count: {
            select: { ridesAsCustomer: true },
          },
        },
      });

      if (!customer) {
        return reply.status(404).send({
          success: false,
          message: 'Customer not found',
        });
      }

      const regDate = customer.createdAt ? customer.createdAt.toISOString().split('T')[0] : '';
      const lastActiveDate = customer.updatedAt ? customer.updatedAt.toISOString().replace('T', ' ').substring(0, 16) : '';

      return reply.send({
        success: true,
        data: {
          id: customer.id,
          customerCode: formatCustomerCode(customer.id),
          name: customer.name || 'Customer',
          phone: customer.phone,
          email: customer.email || '',
          zone: 'Puducherry',
          address: customer.customerProfile?.address || '',
          registrationDate: regDate,
          lastActive: lastActiveDate,
          status: customer.isActive ? 'Active' : 'Inactive',
          totalRides: customer._count?.ridesAsCustomer ?? customer.customerProfile?.totalRides ?? 0,
          totalSpent: 0.0,
          averageRating: customer.customerProfile?.rating ?? 5.0,
          preferredPayment: 'Cash/UPI',
          emergencyContact: customer.customerProfile?.emergencyContact || '',
          dateOfBirth: customer.customerProfile?.dob || '',
          gender: customer.customerProfile?.gender || '',
        },
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to retrieve customer details',
        error: String(error),
      });
    }
  }

  /**
   * Update customer status (Active, Inactive, Blocked)
   */
  async updateCustomerStatus(
    req: FastifyRequest<any>,
    reply: FastifyReply
  ) {
    const { id } = req.params as { id: string };
    const { status } = (req.body as any) || {};

    if (!status) {
      return reply.status(400).send({
        success: false,
        message: 'Status is required',
      });
    }

    try {
      const isActive = status.toLowerCase() === 'active';
      const updated = await prisma.user.update({
        where: { id },
        data: { isActive },
      });

      return reply.send({
        success: true,
        message: `Customer status updated to ${status}`,
        data: { id: updated.id, status: updated.isActive ? 'Active' : 'Inactive' },
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to update customer status',
        error: String(error),
      });
    }
  }

  /**
   * Manually add new customer from Admin Panel
   */
  async addCustomer(
    req: FastifyRequest<any>,
    reply: FastifyReply
  ) {
    const { name, phone, email, address } = (req.body as any) || {};

    if (!name || !phone) {
      return reply.status(400).send({
        success: false,
        message: 'Name and phone are required',
      });
    }

    try {
      const existing = await prisma.user.findFirst({
        where: {
          OR: [{ phone }, email ? { email } : { phone }],
        },
      });

      if (existing) {
        return reply.status(400).send({
          success: false,
          message: 'User with this phone or email already exists',
        });
      }

      const created = await prisma.user.create({
        data: {
          name,
          phone,
          email: email || null,
          role: 'CUSTOMER',
          isActive: true,
          customerProfile: {
            create: {
              address: address || null,
              rating: 5.0,
            },
          },
        },
        include: {
          customerProfile: true,
        },
      });

      return reply.status(201).send({
        success: true,
        message: 'Customer created successfully',
        data: {
          ...created,
          customerCode: formatCustomerCode(created.id),
        },
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to create customer',
        error: String(error),
      });
    }
  }

  /**
   * List all ride requests with relational customer and driver details
   */
  async getRides(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { status, limit, customerId } = (req.query as any) || {};
      const where: any = {};
      if (status) {
        where.status = status;
      }
      if (customerId) {
        const cleanCustId = String(customerId).trim();
        const isCustCode = cleanCustId.toUpperCase().startsWith('CUST-');
        if (isCustCode) {
          const suffix = cleanCustId.substring(5).replace(/-/g, '').toLowerCase();
          where.customer = { id: { endsWith: suffix } };
        } else {
          where.customerId = cleanCustId;
        }
      }

      const rides = await prisma.ride.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit ? parseInt(limit, 10) : 50,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { name: true, phone: true } },
              assignedVehicle: true,
            },
          },
          vehicle: true,
          fareBreakdown: true,
        },
      });

      const formatted = rides.map((r) => formatRideResponse(r));

      return reply.send({
        success: true,
        data: formatted,
        count: formatted.length,
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to retrieve ride requests',
        error: String(error),
      });
    }
  }

  /**
   * Get all rides for a specific customer
   */
  async getCustomerRides(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const cleanId = String(id).trim();
      const isCustCode = cleanId.toUpperCase().startsWith('CUST-');
      const suffix = isCustCode ? cleanId.substring(5).replace(/-/g, '').toLowerCase() : null;

      let targetUserId = cleanId;
      if (isCustCode && suffix) {
        const user = await prisma.user.findFirst({
          where: {
            role: 'CUSTOMER',
            id: { endsWith: suffix },
          },
          select: { id: true },
        });
        if (user) {
          targetUserId = user.id;
        }
      }

      const rides = await prisma.ride.findMany({
        where: { customerId: targetUserId },
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { name: true, phone: true } },
              assignedVehicle: true,
            },
          },
          vehicle: true,
          fareBreakdown: true,
        },
      });

      const formatted = rides.map((r) => formatRideResponse(r));

      return reply.send({
        success: true,
        data: formatted,
        count: formatted.length,
      });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to retrieve customer rides',
        error: String(error),
      });
    }
  }

  /**
   * Get single ride request by ID or bookingCode
   */
  async getRideById(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const ride = await prisma.ride.findFirst({
        where: {
          OR: [{ id }, { bookingCode: id }],
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { name: true, phone: true } },
              assignedVehicle: true,
            },
          },
          vehicle: true,
          fareBreakdown: true,
        },
      });

      if (!ride) {
        return reply.status(404).send({ success: false, message: 'Ride not found' });
      }

      return reply.send({ success: true, data: formatRideResponse(ride) });
    } catch (error) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: 'Failed to retrieve ride',
        error: String(error),
      });
    }
  }

  /**
   * Query candidate drivers and their live availability for a specific ride request
   */
  async getEligibleDrivers(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const result = await driverAvailabilityService.getCandidateDriversForRide(id);
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      req.log.error(error);
      const isNotFound = String(error.message || '').toLowerCase().includes('not found');
      return reply.status(isNotFound ? 404 : 500).send({
        success: false,
        message: error.message || 'Failed to retrieve candidate drivers',
      });
    }
  }

  /**
   * Assign driver (and optional vehicle) to a ride request with full availability validation
   * and database concurrency protection to prevent double-booking.
   */
  async assignRide(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const { driverId, vehicleId } = (req.body as any) || {};

      if (!driverId) {
        return reply.status(400).send({
          success: false,
          message: 'driverId is required for manual assignment',
        });
      }

      // 1. Locate ride by id or bookingCode
      const rawId = String(id).trim();
      const cleanId = rawId.replace(/^#/, '').trim();
      const ride = await prisma.ride.findFirst({
        where: {
          OR: [
            { id: rawId },
            { bookingCode: rawId },
            { id: cleanId },
            { bookingCode: cleanId },
          ],
        },
        include: {
          fareBreakdown: true,
        },
      });

      if (!ride) {
        return reply.status(404).send({ success: false, message: 'Ride not found' });
      }

      if (ride.status === 'COMPLETED' || ride.status === 'CANCELLED') {
        return reply.status(400).send({
          success: false,
          message: `Cannot assign driver to a ${ride.status.toLowerCase()} ride`,
        });
      }

      // Reject assignment if scheduled ride pickup time has already expired or 30 minutes elapsed from creation
      const targetRide = driverAvailabilityService.extractRideTarget(ride);
      const isPastPickup = targetRide.isScheduled && targetRide.scheduledAt && targetRide.scheduledAt.getTime() < Date.now();
      const isOver30Mins = targetRide.isScheduled && ride.createdAt && (Date.now() - new Date(ride.createdAt).getTime()) >= 30 * 60 * 1000;
      if (targetRide.isScheduled && (isPastPickup || isOver30Mins)) {
        return reply.status(400).send({
          success: false,
          message: 'Scheduled trip time expired. Driver assignment is not allowed.',
        });
      }

      // 2. Locate candidate driver strictly (NO silent fallback to first driver!)
      const rawStr = String(driverId).trim();
      const cleanDriverId = rawStr
        .replace(/^GC-/i, '')
        .replace(/^DRV-/i, '')
        .replace(/-/g, '')
        .toLowerCase();

      const allDrivers = await prisma.driverProfile.findMany({
        include: { assignedVehicle: true, user: true, ownedVehicles: true },
      });

      const matchedDriver = allDrivers.find((d) => {
        const dCleanId = d.id.replace(/-/g, '').toLowerCase();
        const dCleanUserId = d.userId ? d.userId.replace(/-/g, '').toLowerCase() : '';
        return (
          d.id === rawStr ||
          d.id === driverId ||
          d.userId === rawStr ||
          d.user?.id === rawStr ||
          d.user?.phone === rawStr ||
          dCleanId === cleanDriverId ||
          dCleanId.startsWith(cleanDriverId) ||
          cleanDriverId.startsWith(dCleanId.substring(0, 5)) ||
          (dCleanUserId && dCleanUserId.startsWith(cleanDriverId))
        );
      });

      if (!matchedDriver) {
        return reply.status(404).send({
          success: false,
          message: `Driver "${driverId}" not found. Manual dispatch requires a valid registered driver.`,
        });
      }

      const finalDriverId = matchedDriver.id;
      const finalVehicleId = vehicleId || matchedDriver.assignedVehicleId || matchedDriver.assignedVehicle?.id || null;

      // 3. Centralized Driver Availability & Time-Conflict Validation
      const availability = await driverAvailabilityService.evaluateDriverAvailability(finalDriverId, targetRide);

      if (!availability.isAvailable) {
        return reply.status(409).send({
          success: false,
          message: availability.reasonMessage || 'Driver is unavailable due to an active trip or schedule conflict',
          reasonCode: availability.reasonCode,
          conflictDetails: {
            reasonCode: availability.reasonCode,
            reasonMessage: availability.reasonMessage,
            activeTripId: availability.activeTripId,
            conflictingTripId: availability.conflictingTripId,
            expectedFreeTime: availability.expectedFreeTime,
          },
        });
      }

      const assignStatus = (req.body as any)?.autoAccept ? 'ACCEPTED' : 'SEARCHING';

      // 4. Concurrency Protection: Re-evaluate and persist inside database transaction
      const updated = await prisma.$transaction(async (tx) => {
        const currentRide = await tx.ride.findUnique({
          where: { id: ride.id },
          select: { id: true, status: true, driverId: true },
        });

        if (!currentRide) {
          throw new Error('Ride not found');
        }

        if (currentRide.status === 'COMPLETED' || currentRide.status === 'CANCELLED') {
          throw new Error(`Ride status is already ${currentRide.status}`);
        }

        // Concurrency re-check: verify driver has not been concurrently assigned to an overlapping trip
        const recheckAvailability = await driverAvailabilityService.evaluateDriverAvailability(
          finalDriverId,
          targetRide
        );
        if (!recheckAvailability.isAvailable) {
          throw new Error(`CONCURRENCY_CONFLICT: ${recheckAvailability.reasonMessage}`);
        }

        return tx.ride.update({
          where: { id: ride.id },
          data: {
            driverId: finalDriverId,
            vehicleId: finalVehicleId,
            status: assignStatus,
          },
          include: {
            customer: { select: { id: true, name: true, phone: true } },
            driver: {
              include: {
                user: { select: { name: true, phone: true } },
                assignedVehicle: true,
              },
            },
            vehicle: true,
            fareBreakdown: true,
          },
        });
      });

      // 5. Send push notifications:
      // a) To the assigned Driver to alert them of the assigned trip
      // b) To the Customer informing them of driver details and their Pickup OTP
      try {
        const { notificationsService } = await import('../notifications/notifications.service');
        const smartCode = updated.bookingCode || `GC-${updated.id.replace(/-/g, '').substring(0, 6).toUpperCase()}`;
        const pickupOtp = updated.startOtp || '';

        const dp = await prisma.driverProfile.findUnique({
          where: { id: finalDriverId },
          select: { userId: true },
        });
        if (dp?.userId) {
          await notificationsService.sendToUser({
            userId: dp.userId,
            title: '🚖 New Trip Assigned!',
            message: `You have been assigned ride ${smartCode}. Open app to accept.`,
            type: 'ride_assigned',
            data: {
              rideId: updated.id,
              bookingCode: smartCode,
              pickupLocation: updated.pickupLocation,
              pickupAddress: updated.pickupAddress || updated.pickupLocation,
              dropLocation: updated.dropLocation,
              dropAddress: updated.dropAddress || updated.dropLocation,
              distance: `${updated.distanceKm} km`,
              estimatedFare: `₹${Math.round(updated.fareBreakdown?.totalFare ?? updated.estimatedFare ?? 0)}`,
              tripType: standardizeTripType({
                customTripType: (updated.stops as any)?.customTripType,
                tripType: updated.tripType,
                distanceKm: updated.distanceKm,
              }),
              isElite: String(!!(
                (updated.stops as any)?.isElite ||
                (updated.stops as any)?.category === 'ELITE' ||
                (updated.stops as any)?.requestedVehicle?.toLowerCase().includes('elite') ||
                updated.tripType?.toLowerCase().includes('elite')
              )),
              paymentMethod: updated.paymentMethod,
              customerName: updated.customer?.name || 'Customer',
              customerPhone: updated.customer?.phone || '',
              startOtp: pickupOtp,
              pickupLat: String(updated.pickupLat ?? 11.9360),
              pickupLng: String(updated.pickupLng ?? 79.8174),
              dropLat: String(updated.dropLat ?? 11.9680),
              dropLng: String(updated.dropLng ?? 79.8105),
            },
          });
        }

        // Notify the Customer ONLY if already accepted (autoAccept), NOT while waiting for driver acceptance
        if (updated.customerId && assignStatus === 'ACCEPTED') {
          const driverName = updated.driver?.user?.name || 'Your driver';
          const driverPhone = updated.driver?.user?.phone || '';
          const vehicleModel = updated.driver?.assignedVehicle?.model || updated.vehicle?.model || 'Cab';
          const vehicleNumber = updated.driver?.assignedVehicle?.vehicleNumber || updated.vehicle?.vehicleNumber || '';
          const vehicleInfo = vehicleNumber ? `${vehicleModel} (${vehicleNumber})` : vehicleModel;

          await notificationsService.sendToUser({
            userId: updated.customerId,
            title: '🚖 Driver Assigned & Confirmed!',
            message: `${driverName} (${vehicleInfo}) has been assigned. Your Pickup OTP is ${pickupOtp}. Share with driver when boarding.`,
            type: 'driver_assigned',
            data: {
              rideId: updated.id,
              bookingCode: smartCode,
              startOtp: pickupOtp,
              driverName,
              driverPhone,
              vehicleModel,
              vehicleNumber,
            },
          });
        }
      } catch (e) {
        req.log.warn('Failed to send assignment notifications: ' + e);
      }

      return reply.send({
        success: true,
        message: 'Driver assigned successfully',
        data: formatRideResponse(updated),
      });
    } catch (error: any) {
      req.log.error(error);
      const isConcurrencyConflict = String(error.message || '').includes('CONCURRENCY_CONFLICT');
      const statusCode = isConcurrencyConflict ? 409 : 500;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to assign driver',
        error: String(error),
      });
    }
  }

  async getSubAdmins(req: FastifyRequest, reply: FastifyReply) {
    try {
      const admins = await prisma.user.findMany({
        where: {
          role: { in: ['ADMIN', 'ZONE_ADMIN', 'SUPER_ADMIN', 'DISPATCHER'] },
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          isActive: true,
          assignedZoneId: true,
          assignedZone: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const formatted = admins.map((admin) => ({
        ...admin,
        adminCode: formatAdminCode(admin.id),
        displayId: formatAdminCode(admin.id),
      }));
      return reply.send({ success: true, data: formatted });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch sub-admins', error: error.message });
    }
  }

  async createSubAdmin(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { name, phone, email, password, role = 'ZONE_ADMIN', assignedZoneId } = (req.body as any) || {};

      if (!name || !phone || !password) {
        return reply.status(400).send({ success: false, message: 'Name, phone, and password are required' });
      }

      const existing = await prisma.user.findFirst({
        where: {
          OR: [{ phone }, ...(email ? [{ email: email.toLowerCase() }] : [])],
        },
      });

      if (existing) {
        return reply.status(400).send({ success: false, message: 'An admin or user with this phone/email already exists' });
      }

      const bcrypt = require('bcryptjs');
      const passwordHash = await bcrypt.hash(password, 10);

      const created = await prisma.user.create({
        data: {
          name,
          phone,
          email: email ? email.toLowerCase() : null,
          passwordHash,
          role: role as any,
          assignedZoneId: assignedZoneId || null,
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          assignedZoneId: true,
          assignedZone: true,
          createdAt: true,
        },
      });

      return reply.status(201).send({
        success: true,
        message: 'Admin account created successfully',
        data: {
          ...created,
          adminCode: formatAdminCode(created.id),
          displayId: formatAdminCode(created.id),
        },
      });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to create sub-admin' });
    }
  }

  async updateSubAdmin(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const { name, phone, email, role, isActive, assignedZoneId } = (req.body as any) || {};

      const updated = await prisma.user.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(phone ? { phone } : {}),
          ...(email ? { email: email.toLowerCase() } : {}),
          ...(role ? { role: role as any } : {}),
          ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
          ...(assignedZoneId !== undefined ? { assignedZoneId: assignedZoneId || null } : {}),
        },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          isActive: true,
          assignedZoneId: true,
          assignedZone: true,
          createdAt: true,
        },
      });

      return reply.send({
        success: true,
        message: 'Admin account updated successfully',
        data: {
          ...updated,
          adminCode: formatAdminCode(updated.id),
          displayId: formatAdminCode(updated.id),
        },
      });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update sub-admin' });
    }
  }

  async deleteSubAdmin(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      await prisma.user.update({
        where: { id },
        data: { isActive: false },
      });
      return reply.send({ success: true, message: 'Admin account deactivated successfully' });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to delete sub-admin' });
    }
  }

  async getPayouts(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { status } = req.query as { status?: string };

      const where: any = {
        type: 'WITHDRAWAL',
      };
      if (status && status !== 'All' && status !== 'All Status') {
        const sUpper = status.toUpperCase();
        if (sUpper === 'PAID' || sUpper === 'COMPLETED') where.status = 'COMPLETED';
        else if (sUpper === 'APPROVED') where.status = 'APPROVED';
        else if (sUpper === 'PROCESSING') where.status = 'PROCESSING';
        else if (sUpper === 'PENDING') where.status = 'PENDING';
        else if (sUpper === 'FAILED' || sUpper === 'REJECTED') where.status = 'FAILED';
        else where.status = sUpper;
      }

      const txs = await prisma.walletTransaction.findMany({
        where,
        include: {
          wallet: {
            include: {
              driver: {
                include: {
                  user: true,
                  rides: {
                    where: { status: 'COMPLETED' },
                    select: { id: true, paymentMethod: true, finalFare: true, estimatedFare: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const commissionRate = await platformSettingsService.getCommissionRate();
      const commissionPercent = await platformSettingsService.getCommissionPercent();

      const payouts = txs.map((tx) => {
        const wallet = tx.wallet;
        const driver = wallet?.driver;
        const user = driver?.user;

        let displayStatus = 'Pending';
        if (tx.status === 'COMPLETED') displayStatus = 'Paid';
        else if (tx.status === 'APPROVED') displayStatus = 'Approved';
        else if (tx.status === 'PROCESSING') displayStatus = 'Processing';
        else if (tx.status === 'FAILED') displayStatus = 'Rejected';

        const created = tx.createdAt;
        const dateStr = created.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

        const earningsVal = wallet?.lifetimeEarnings || 0;
        const balanceVal = wallet?.balance || 0;
        const outstandingDues = balanceVal < 0 ? Math.abs(balanceVal) : 0;
        const ridesCount = driver?.rides?.length || 0;
        const payoutAmt = tx.amount;
        const commissionVal = Math.round(earningsVal * commissionRate);

        return {
          id: tx.id,
          transactionId: tx.id,
          driverId: driver?.id ? formatDriverCode(driver.id) : 'DRV-0000',
          rawDriverId: driver?.id || '',
          driverName: user?.name || 'Driver Partner',
          driverPhone: user?.phone || '',
          driverPhoto: driver?.selfieImage || null,
          earnings: `₹ ${Math.round(earningsVal).toLocaleString()}`,
          rawEarnings: earningsVal,
          walletBalance: `₹ ${Math.round(balanceVal).toLocaleString()}`,
          rawWalletBalance: balanceVal,
          outstandingDues: `₹ ${Math.round(outstandingDues).toLocaleString()}`,
          rawOutstandingDues: outstandingDues,
          rides: `${ridesCount} Rides`,
          commission: `₹ ${commissionVal.toLocaleString()}`,
          commissionPercent: `${commissionPercent}%`,
          payoutAmount: `₹ ${Math.round(payoutAmt).toLocaleString()}`,
          rawPayoutAmount: payoutAmt,
          method: wallet?.bankAccountNumber ? 'Bank Transfer' : 'UPI',
          methodDetail: wallet?.bankAccountNumber
            ? `**** ${wallet.bankAccountNumber.slice(-4)}`
            : (wallet?.bankIfsc || 'UPI Transfer'),
          bankAccountNumber: wallet?.bankAccountNumber || '',
          bankIfsc: wallet?.bankIfsc || '',
          bankHolderName: wallet?.bankHolderName || '',
          date: dateStr,
          time: timeStr,
          status: displayStatus,
          rawStatus: tx.status,
          utrNumber: tx.utrNumber || '',
          rejectionReason: tx.rejectionReason || '',
          paidAt: tx.paidAt ? tx.paidAt.toISOString() : null,
          createdAt: tx.createdAt.toISOString(),
        };
      });

      return reply.send({ success: true, data: payouts });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to fetch payouts' });
    }
  }

  async updatePayoutStatus(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const { status, utrNumber, rejectionReason } = (req.body as any) || {};

      const tx = await prisma.walletTransaction.findUnique({
        where: { id },
        include: { wallet: true },
      });

      if (!tx) {
        return reply.status(404).send({ success: false, message: 'Payout transaction not found' });
      }

      const sUpper = (status || '').toUpperCase();
      let targetStatus: any = tx.status;

      if (sUpper === 'APPROVED') {
        targetStatus = 'APPROVED';
      } else if (sUpper === 'PROCESSING') {
        targetStatus = 'PROCESSING';
      } else if (sUpper === 'PAID' || sUpper === 'COMPLETED' || sUpper === 'SUCCESS') {
        targetStatus = 'COMPLETED';
      } else if (sUpper === 'FAILED' || sUpper === 'REJECTED') {
        targetStatus = 'FAILED';
      } else if (sUpper === 'PENDING') {
        targetStatus = 'PENDING';
      }

      // Scenario A: Mark as Paid
      if (targetStatus === 'COMPLETED') {
        if (tx.status === 'COMPLETED') {
          return reply.status(400).send({ success: false, message: 'This payout is already marked as paid' });
        }
        if (tx.status === 'FAILED') {
          return reply.status(400).send({ success: false, message: 'Cannot mark a rejected payout as paid' });
        }

        const cleanUtr = utrNumber ? String(utrNumber).trim() : '';
        if (!cleanUtr) {
          return reply.status(400).send({ success: false, message: 'Bank UTR / Reference number is mandatory to mark payout as paid' });
        }

        const duplicateUtr = await prisma.walletTransaction.findFirst({
          where: {
            utrNumber: cleanUtr,
            id: { not: tx.id },
          },
        });
        if (duplicateUtr) {
          return reply.status(400).send({
            success: false,
            message: `UTR number '${cleanUtr}' has already been recorded for another payout`,
          });
        }

        await prisma.$transaction(async (prismaTx) => {
          await prismaTx.walletTransaction.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              utrNumber: cleanUtr,
              paidAt: new Date(),
            },
          });

          await prismaTx.wallet.update({
            where: { id: tx.walletId },
            data: {
              pendingWithdrawals: {
                decrement: Math.min(tx.wallet.pendingWithdrawals, tx.amount),
              },
            },
          });
        });

        return reply.send({
          success: true,
          message: `Payout marked as PAID (UTR: ${cleanUtr})`,
          data: { id, status: 'COMPLETED', utrNumber: cleanUtr },
        });
      }

      // Scenario B: Reject Payout
      if (targetStatus === 'FAILED') {
        if (tx.status === 'COMPLETED') {
          return reply.status(400).send({ success: false, message: 'Cannot reject an already completed payout' });
        }
        if (tx.status === 'FAILED') {
          // Idempotent: already rejected
          return reply.send({
            success: true,
            message: 'Payout is already marked as rejected',
            data: { id, status: 'FAILED' },
          });
        }

        const cleanReason = rejectionReason ? String(rejectionReason).trim() : '';
        if (!cleanReason) {
          return reply.status(400).send({ success: false, message: 'Rejection reason is mandatory when rejecting a cashout' });
        }

        await prisma.$transaction(async (prismaTx) => {
          const liveWallet = await prismaTx.wallet.findUnique({
            where: { id: tx.walletId },
          });
          if (!liveWallet) throw new Error('Wallet not found');

          const prevBal = liveWallet.balance;
          const restoredBal = Math.round((prevBal + tx.amount) * 100) / 100;

          // 1. Release reserved amount back to driver available balance
          await prismaTx.wallet.update({
            where: { id: tx.walletId },
            data: {
              balance: { increment: tx.amount },
              pendingWithdrawals: {
                decrement: Math.min(liveWallet.pendingWithdrawals, tx.amount),
              },
            },
          });

          // 2. Mark original withdrawal as FAILED
          await prismaTx.walletTransaction.update({
            where: { id },
            data: {
              status: 'FAILED',
              rejectionReason: cleanReason,
            },
          });

          // 3. Create reversal ledger entry for audit trail
          await prismaTx.walletTransaction.create({
            data: {
              walletId: tx.walletId,
              amount: tx.amount,
              type: 'ADJUSTMENT',
              status: 'COMPLETED',
              previousBalance: prevBal,
              newBalance: restoredBal,
              description: `Refund: Cashout request #${tx.id.substring(0, 8)} rejected (${cleanReason})`,
            },
          });
        });

        return reply.send({
          success: true,
          message: `Payout rejected and ₹${tx.amount} released back to driver wallet`,
          data: { id, status: 'FAILED', rejectionReason: cleanReason },
        });
      }

      // Scenario C: APPROVED or PROCESSING
      if (tx.status === 'COMPLETED') {
        return reply.status(400).send({ success: false, message: 'Cannot modify an already completed payout' });
      }
      if (tx.status === 'FAILED') {
        return reply.status(400).send({ success: false, message: 'Cannot modify a rejected payout' });
      }

      await prisma.walletTransaction.update({
        where: { id },
        data: { status: targetStatus },
      });

      return reply.send({
        success: true,
        message: `Payout status updated to ${targetStatus}`,
        data: { id, status: targetStatus },
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to update payout status' });
    }
  }

  async getCommissionSettings(req: FastifyRequest, reply: FastifyReply) {
    try {
      const commissionPercent = await platformSettingsService.getCommissionPercent();
      const commissionRate = await platformSettingsService.getCommissionRate();
      return reply.send({
        success: true,
        data: { commissionPercent, commissionRate },
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to fetch commission settings' });
    }
  }

  async updateCommissionSettings(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { commissionPercent } = (req.body as any) || {};
      const num = Number(commissionPercent);
      if (isNaN(num)) {
        return reply.status(400).send({ success: false, message: 'Commission percentage must be a valid number' });
      }
      const updated = await platformSettingsService.setCommissionPercent(num);
      return reply.send({
        success: true,
        message: `Platform commission updated to ${updated}%`,
        data: { commissionPercent: updated, commissionRate: updated / 100 },
      });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update commission settings' });
    }
  }

  async getSettlementsOverview(req: FastifyRequest, reply: FastifyReply) {
    try {
      const wallets = await prisma.wallet.findMany();
      let totalDriverLifetimeEarnings = 0;
      let totalOutstandingDues = 0;
      let totalAvailableBalances = 0;
      let totalPendingWithdrawals = 0;

      for (const w of wallets) {
        totalDriverLifetimeEarnings += w.lifetimeEarnings;
        totalPendingWithdrawals += w.pendingWithdrawals;
        if (w.balance < 0) {
          totalOutstandingDues += Math.abs(w.balance);
        } else {
          totalAvailableBalances += w.balance;
        }
      }

      const completedRides = await prisma.ride.findMany({
        where: { status: 'COMPLETED' },
        include: { fareBreakdown: true },
      });

      let totalCashCollections = 0;
      let totalOnlineCollections = 0;
      let totalCompanyCommission = 0;
      const commissionRate = await platformSettingsService.getCommissionRate();
      const commissionPercent = await platformSettingsService.getCommissionPercent();

      for (const r of completedRides) {
        const fare = r.fareBreakdown?.totalFare ?? r.finalFare ?? r.estimatedFare ?? 0;
        const discount = r.fareBreakdown?.discountAmount ?? 0;
        const gross = fare + discount;
        const commission = Math.round(gross * commissionRate * 100) / 100;

        totalCompanyCommission += commission;
        if (r.paymentMethod === 'CASH') {
          totalCashCollections += fare;
        } else {
          totalOnlineCollections += fare;
        }
      }

      const paidPayouts = await prisma.walletTransaction.aggregate({
        where: { type: 'WITHDRAWAL', status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true,
      });

      const pendingPayouts = await prisma.walletTransaction.aggregate({
        where: {
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
        },
        _sum: { amount: true },
        _count: true,
      });

      return reply.send({
        success: true,
        data: {
          totalDriverLifetimeEarnings: Math.round(totalDriverLifetimeEarnings * 100) / 100,
          totalOutstandingDues: Math.round(totalOutstandingDues * 100) / 100,
          totalAvailableBalances: Math.round(totalAvailableBalances * 100) / 100,
          totalPendingWithdrawals: Math.round(totalPendingWithdrawals * 100) / 100,
          totalCashCollections: Math.round(totalCashCollections * 100) / 100,
          totalOnlineCollections: Math.round(totalOnlineCollections * 100) / 100,
          totalCompanyCommission: Math.round(totalCompanyCommission * 100) / 100,
          totalPaidOut: Math.round((paidPayouts._sum.amount || 0) * 100) / 100,
          completedPayoutsCount: paidPayouts._count || 0,
          pendingPayoutsCount: pendingPayouts._count || 0,
          totalActiveDrivers: wallets.length,
          totalCompletedRides: completedRides.length,
        },
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to fetch settlements overview' });
    }
  }

  async getPayments(req: FastifyRequest, reply: FastifyReply) {
    try {
      const query = (req.query as any) || {};
      const { paymentMethod, status, startDate, endDate, search } = query;

      const where: any = {};

      if (paymentMethod && paymentMethod !== 'All' && paymentMethod !== 'All Payment Types') {
        where.paymentMethod = paymentMethod.toUpperCase();
      }

      if (status && status !== 'All') {
        const s = status.toUpperCase();
        if (s === 'PAID' || s === 'COMPLETED') {
          where.paymentStatus = 'PAID';
        } else if (s === 'PENDING') {
          where.paymentStatus = 'PENDING';
          where.status = { not: 'CANCELLED' };
        } else if (s === 'CANCELLED') {
          where.status = 'CANCELLED';
        } else if (s === 'REFUNDED') {
          where.paymentStatus = 'REFUNDED';
        }
      }

      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) {
          where.createdAt.gte = new Date(startDate);
        }
        if (endDate) {
          where.createdAt.lte = new Date(endDate);
        }
      }

      if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
          { bookingCode: { contains: s, mode: 'insensitive' } },
          { customer: { name: { contains: s, mode: 'insensitive' } } },
          { customer: { phone: { contains: s, mode: 'insensitive' } } },
          { driver: { user: { name: { contains: s, mode: 'insensitive' } } } },
          { driver: { user: { phone: { contains: s, mode: 'insensitive' } } } },
        ];
      }

      const rides = await prisma.ride.findMany({
        where,
        include: {
          customer: true,
          driver: { include: { user: true } },
          fareBreakdown: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const payments = rides.map((r) => {
        const meta = (r.stops as any) || {};
        const fare = r.finalFare || r.fareBreakdown?.totalFare || r.estimatedFare || 0.0;
        // Strictly check paymentStatus === 'PAID'
        const isPaid = r.paymentStatus === 'PAID';

        return {
          orderId: r.bookingCode || `GC-${r.id.substring(0, 5).toUpperCase()}`,
          // Internal reference - not pretending to be a gateway transaction ID
          paymentId: r.bookingCode ? `REF-${r.bookingCode}` : `REF-${r.id.substring(0, 8).toUpperCase()}`,
          rideId: r.id,
          userName: r.customer?.name || 'Customer',
          customerPhone: r.customer?.phone || '',
          driverName: r.driver?.user?.name || 'Driver Partner',
          driverPhone: r.driver?.user?.phone || '',
          tripType: standardizeTripType({
            customTripType: meta.customTripType,
            tripType: r.tripType,
            distanceKm: r.distanceKm,
          }),
          amount: fare,
          paymentMode: r.paymentMethod || 'CASH',
          paymentStatus: r.paymentStatus,
          rideStatus: r.status,
          status: isPaid,
          timestamp: r.createdAt.toISOString(),
          zone: meta.zone || 'Puducherry',
          pickupLocation: r.pickupAddress || r.pickupLocation || '',
          dropLocation: r.dropAddress || r.dropLocation || '',
          stops: meta.additionalStops || [],
        };
      });

      const totalRevenue = payments.reduce((acc, p) => acc + (p.status ? p.amount : 0), 0);
      const totalTransactions = payments.length;
      const completedCount = payments.filter((p) => p.status).length;
      const pendingCount = payments.filter((p) => p.paymentStatus === 'PENDING' && p.rideStatus !== 'CANCELLED').length;
      const cancelledCount = payments.filter((p) => p.rideStatus === 'CANCELLED').length;

      return reply.send({
        success: true,
        data: {
          payments,
          stats: {
            totalRevenue,
            totalTransactions,
            completedCount,
            pendingCount,
            cancelledCount,
          },
        },
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to fetch payments' });
    }
  }

  async getLiveMapData(req: FastifyRequest, reply: FastifyReply) {
    try {
      const activeRides = await prisma.ride.findMany({
        where: {
          status: { in: ['SEARCHING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
              assignedVehicle: true,
            },
          },
          fareBreakdown: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const drivers = await prisma.driverProfile.findMany({
        include: {
          user: { select: { id: true, name: true, phone: true, isActive: true } },
          assignedVehicle: true,
          assignedHub: true,
          rides: {
            where: {
              status: { in: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
            },
            take: 1,
            select: {
              id: true,
              bookingCode: true,
              status: true,
              pickupLocation: true,
              dropLocation: true,
              pickupLat: true,
              pickupLng: true,
              dropLat: true,
              dropLng: true,
              estimatedFare: true,
              finalFare: true,
              distanceKm: true,
              tripType: true,
              customer: { select: { name: true, phone: true } },
            },
          },
        },
      });

      const cityClusters: Record<string, { lat: number; lng: number }> = {
        chennai: { lat: 13.0827, lng: 80.2707 },
        puducherry: { lat: 11.9416, lng: 79.8083 },
        coimbatore: { lat: 11.0168, lng: 76.9558 },
        madurai: { lat: 9.9252, lng: 78.1198 },
        trichy: { lat: 10.7905, lng: 78.7047 },
        salem: { lat: 11.6643, lng: 78.1460 },
      };

      const cachedDriverIds = new Set<string>(drivers.map((d) => d.id));
      for (const r of activeRides) {
        if (r.driverId) cachedDriverIds.add(r.driverId);
      }
      const cachedLocations = await locationCacheService.getLocationsForDrivers(Array.from(cachedDriverIds));

      const STALE_LOCATION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();

      const mappedDrivers = drivers.map((d, index) => {
        const user = d.user;
        const activeRide = d.rides && d.rides.length > 0 ? d.rides[0] : null;
        const isOnTrip = !!activeRide;

        let displayStatus = 'Offline';
        if (isOnTrip) {
          displayStatus = 'On Trip';
        } else if (d.isOnline || d.shiftStatus === 'ON_SHIFT') {
          displayStatus = 'Online';
        }

        const cached = cachedLocations.get(d.id);
        let lat: number | null | undefined;
        let lng: number | null | undefined;
        let locationUpdatedAt = d.updatedAt ? d.updatedAt.toISOString() : new Date().toISOString();

        if (isOnTrip) {
          // Rule 1: Active ride tracking is always prioritized
          if (cached) {
            lat = cached.latitude;
            lng = cached.longitude;
            locationUpdatedAt = new Date(cached.updatedAt).toISOString();
          } else {
            lat = d.currentLatitude;
            lng = d.currentLongitude;
          }
        } else if (d.isOnline || d.shiftStatus === 'ON_SHIFT') {
          // Rule 2: Online / available driver -> apply stale filter (max 5 minutes)
          const isFresh = cached && (now - cached.updatedAt <= STALE_LOCATION_THRESHOLD_MS);
          if (isFresh && cached) {
            lat = cached.latitude;
            lng = cached.longitude;
            locationUpdatedAt = new Date(cached.updatedAt).toISOString();
          } else {
            // Stale or no cache -> fall back to authoritative DB coordinates
            lat = d.currentLatitude;
            lng = d.currentLongitude;
          }
        } else {
          // Rule 3: Offline / inactive driver -> do not show stale moving cache, fall back to DB
          lat = d.currentLatitude;
          lng = d.currentLongitude;
        }

        if (!lat || !lng || (lat === 0 && lng === 0)) {
          const base = (d.assignedHub?.latitude && d.assignedHub?.longitude)
            ? { lat: d.assignedHub.latitude, lng: d.assignedHub.longitude }
            : (d.assignedHub?.city?.toLowerCase() === 'puducherry' ? cityClusters.puducherry : cityClusters.chennai);
          const angle = (index * 137.5) * (Math.PI / 180);
          const radius = 0.008 + (index % 5) * 0.005;
          lat = base.lat + Math.sin(angle) * radius;
          lng = base.lng + Math.cos(angle) * radius;
        }

        let city = d.assignedHub?.city || '';
        if (!city) {
          let minDist = Infinity;
          let nearestCity = 'Chennai';
          for (const [cityName, cluster] of Object.entries(cityClusters)) {
            const dLat = lat - cluster.lat;
            const dLng = lng - cluster.lng;
            const dist = dLat * dLat + dLng * dLng;
            if (dist < minDist) {
              minDist = dist;
              nearestCity = cityName.charAt(0).toUpperCase() + cityName.slice(1);
            }
          }
          city = nearestCity;
        }

        return {
          id: d.id,
          driverCode: formatDriverCode(d.id),
          name: user?.name || 'Driver Partner',
          phone: user?.phone || '',
          photo: d.selfieImage || null,
          city,
          isOnline: d.isOnline || d.shiftStatus === 'ON_SHIFT',
          isOnTrip,
          status: displayStatus,
          shiftStatus: d.shiftStatus,
          latitude: lat,
          longitude: lng,
          updatedAt: locationUpdatedAt,
          vehicleModel: d.assignedVehicle?.model || 'Sedan',
          vehicleNumber: d.assignedVehicle?.vehicleNumber || 'TN-01-REG',
          vehicleType: d.assignedVehicle?.vehicleType || 'Sedan',
          currentRide: activeRide ? {
            id: activeRide.id,
            bookingCode: activeRide.bookingCode,
            status: activeRide.status,
            customerName: activeRide.customer?.name || 'Customer',
            customerPhone: activeRide.customer?.phone || '',
            pickup: activeRide.pickupLocation,
            drop: activeRide.dropLocation,
            pickupLat: activeRide.pickupLat,
            pickupLng: activeRide.pickupLng,
            dropLat: activeRide.dropLat,
            dropLng: activeRide.dropLng,
            amount: activeRide.finalFare || activeRide.estimatedFare || 0,
            distance: activeRide.distanceKm || 0,
            tripType: activeRide.tripType,
          } : null,
        };
      });

      const mappedRides = activeRides.map((r) => {
        const meta = (r.stops as any) || {};
        const fare = r.finalFare || r.fareBreakdown?.totalFare || r.estimatedFare || 0;
        const cachedDriverLoc = r.driverId ? cachedLocations.get(r.driverId) : undefined;
        return {
          id: r.id,
          bookingId: r.bookingCode || r.id,
          customerName: r.customer?.name || 'Customer',
          customerPhone: r.customer?.phone || '',
          driverName: r.driver?.user?.name || 'Unassigned',
          driverPhone: r.driver?.user?.phone || '',
          driverId: r.driverId ? formatDriverCode(r.driverId) : null,
          driverLat: cachedDriverLoc ? cachedDriverLoc.latitude : (r.driver?.currentLatitude || null),
          driverLng: cachedDriverLoc ? cachedDriverLoc.longitude : (r.driver?.currentLongitude || null),
          amount: `₹${Math.round(fare)}`,
          rawAmount: fare,
          pickupLocation: r.pickupAddress || r.pickupLocation,
          dropLocation: r.dropAddress || r.dropLocation,
          pickupLat: r.pickupLat,
          pickupLng: r.pickupLng,
          dropLat: r.dropLat,
          dropLng: r.dropLng,
          distance: `${r.distanceKm || 0} km`,
          status: r.status,
          tripType: standardizeTripType({
            customTripType: meta.customTripType,
            tripType: r.tripType,
            distanceKm: r.distanceKm,
          }),
          zone: meta.zone || 'Chennai',
          createdAt: r.createdAt.toISOString(),
        };
      });

      const totalDrivers = drivers.length;
      const onlineDrivers = mappedDrivers.filter((d) => d.status === 'Online').length;
      const onTripDrivers = mappedDrivers.filter((d) => d.status === 'On Trip').length;
      const offlineDrivers = mappedDrivers.filter((d) => d.status === 'Offline').length;
      const activeTripsCount = mappedRides.length;

      return reply.send({
        success: true,
        data: {
          drivers: mappedDrivers,
          rides: mappedRides,
          stats: {
            totalDrivers,
            onlineDrivers: onlineDrivers + onTripDrivers,
            availableDrivers: onlineDrivers,
            onTripDrivers,
            offlineDrivers,
            activeTrips: activeTripsCount,
            sosAlerts: 0,
          },
          cityCenters: cityClusters,
        },
      });
    } catch (error: any) {
      req.log.error(error);
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch live map data',
      });
    }
  }
}

export const adminController = new AdminController();
