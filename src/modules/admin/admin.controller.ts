import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../config/prisma';
import { standardizeTripType } from '../../utils/trip-type.helper';
import { driverAvailabilityService } from '../rides/driver-availability.service';

function formatDriverCode(driverId?: string | null): string | null {
  if (!driverId) return null;
  const clean = driverId.replace(/^DRV-/i, '').replace(/-/g, '').toUpperCase();
  const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');
  return `DRV-${suffix}`;
}

function formatRideResponse(r: any) {
  const meta = (r.stops as any) || {};
  const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;

  let displayStatus = 'New Request';
  if (isScheduled && !r.driverId && r.status === 'SEARCHING') {
    displayStatus = 'Scheduled';
  } else if (r.status === 'SEARCHING') {
    displayStatus = r.driverId ? 'Assigned' : 'New Request';
  } else if (r.status === 'ACCEPTED') {
    displayStatus = 'Assigned';
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

  return {
    id: r.id,
    bookingId: r.bookingCode || r.id,
    type: tripType,
    isElite,
    category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
    datetime: finalDatetime,
    status: displayStatus,
    dbStatus: r.status,
    customerId: r.customer?.id || r.customerId,
    customerName: r.customer?.name || 'Customer',
    customerPhone: r.customer?.phone || '',
    requestedVehicleId: reqVehicle,
    requestedSeatCount: seatCap,
    assignedDriverId: rawDriverId,
    assignedDriverCode: driverCode,
    assignedDriverName: r.driver?.user?.name || null,
    assignedDriverPhone: r.driver?.user?.phone || null,
    assignedVehicleId: r.vehicleId || null,
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
      const customer = await prisma.user.findFirst({
        where: { id, role: 'CUSTOMER' },
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
        data: created,
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
      const { status, limit } = (req.query as any) || {};
      const where: any = {};
      if (status) {
        where.status = status;
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
      const targetRide = driverAvailabilityService.extractRideTarget(ride);
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

        // Notify the Customer with assigned driver info and Pickup OTP
        if (updated.customerId) {
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
      return reply.send({ success: true, data: admins });
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

      return reply.status(201).send({ success: true, message: 'Admin account created successfully', data: created });
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

      return reply.send({ success: true, message: 'Admin account updated successfully', data: updated });
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
}

export const adminController = new AdminController();
