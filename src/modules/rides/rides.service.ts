import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { platformSettingsService } from '../settings/platform-settings.service';
import { unavailabilityService } from '../unavailability/unavailability.service';
import { locationCacheService } from '../drivers/location-cache.service';
import { vehiclesService } from '../vehicles/vehicles.service';
import { TripStatus } from '../../generated/prisma/client';
import { standardizeTripType } from '../../utils/trip-type.helper';

/**
 * Permitted window (in minutes) before scheduled pickup time within which a driver can initiate trip start.
 * Centralized constant to enforce consistent business rules across API and client applications.
 */
export const SCHEDULED_START_WINDOW_MINUTES = 30;

export interface EstimateFareInput {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  tripType?: 'DAILY' | 'RENTAL' | 'OUTSTATION' | 'ONE_WAY' | 'ROUND_TRIP';
  category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
}

/**
 * Robust scheduled pickup time parser supporting standard ISO, formatted date strings
 * (e.g. "Mon, 27 Oct, 10:30 AM", "27 Oct 2026, 10:30 AM", "yyyy-MM-dd HH:mm"),
 * and intelligently attaching the current or upcoming year if omitted.
 */
export function parseScheduledPickupTime(scheduledAtStr?: string | null): Date | null {
  if (!scheduledAtStr || !scheduledAtStr.trim() || scheduledAtStr.trim() === 'Pick-up now') {
    return null;
  }
  const raw = scheduledAtStr.trim();
  const now = new Date();
  const currentYear = now.getFullYear();

  // 1. Direct standard ISO / Date parse
  let parsed = new Date(raw);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= currentYear) {
    return parsed;
  }

  // 2. If year was missing (V8 defaults to 2001) or parsing failed:
  // Remove weekday prefix if present (e.g., 'Mon, ', 'Tue, ')
  const cleaned = raw.replace(/^[A-Za-z]{3},\s*/, '');

  // Try appending current year: e.g. '27 Oct, 10:30 AM 2026'
  let withYear = new Date(`${cleaned} ${currentYear}`);
  if (!isNaN(withYear.getTime())) {
    // If withYear is in past (e.g. Dec booked in Jan), roll over to next year
    if (withYear.getTime() < now.getTime() - 86400000) {
      withYear = new Date(`${cleaned} ${currentYear + 1}`);
    }
    return withYear;
  }

  // Try comma-separated year: '27 Oct 2026, 10:30 AM'
  const withCommaYear = new Date(cleaned.replace(',', ` ${currentYear},`));
  if (!isNaN(withCommaYear.getTime())) {
    return withCommaYear;
  }

  return null;
}

export class RidesService {
  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const R = 6371; // Earth radius in KM
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const dist = R * c;
    return Math.max(1, Math.round(dist * 10) / 10);
  }

  /**
   * Estimate ride fare
   */
  async estimateFare(input: EstimateFareInput & { distanceKm?: number }) {
    const isRound = input.tripType === 'ROUND_TRIP';
    let distanceKm = typeof input.distanceKm === 'number' && input.distanceKm > 0
      ? input.distanceKm
      : this.calculateDistanceKm(
          input.pickupLat,
          input.pickupLng,
          input.dropLat,
          input.dropLng
        );

    // If Haversine fallback was used and it's a round trip, double it
    if (!input.distanceKm && isRound) {
      distanceKm = Math.round(distanceKm * 2 * 10) / 10;
    }

    // Rate configurations based on vehicle category
    let ratePerKm = 14.0;
    let baseFare = 50.0;

    if (input.category === 'PREMIUM') {
      ratePerKm = 18.0;
      baseFare = 80.0;
    } else if (input.category === 'LUXURY') {
      ratePerKm = 24.0;
      baseFare = 150.0;
    }

    let driverBata = 0;
    if (input.tripType === 'OUTSTATION' || input.tripType === 'ROUND_TRIP') {
      driverBata = 300.0;
    }

    const calculatedFare = baseFare + distanceKm * ratePerKm + driverBata;
    const totalFare = Math.round(calculatedFare);

    return {
      distanceKm,
      pricePerKm: ratePerKm,
      baseFare,
      driverBata,
      estimatedFare: totalFare,
    };
  }

  /**
   * Customer requests a new ride
   */
  async requestRide(customerId: string, data: {
    pickupLocation: string;
    pickupAddress?: string;
    pickupLat: number;
    pickupLng: number;
    dropLocation: string;
    dropAddress?: string;
    dropLat: number;
    dropLng: number;
    distanceKm?: number;
    tripType?: 'DAILY' | 'RENTAL' | 'OUTSTATION' | 'ONE_WAY' | 'ROUND_TRIP';
    customTripType?: string;
    isElite?: boolean;
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
    paymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'WALLET';
    couponCode?: string;
    scheduledAt?: string;
    requestedSeats?: string;
    seatCapacity?: number;
    requestedVehicle?: string;
    carName?: string;
    additionalStops?: string[];
    stops?: any;
  }) {
    const clientDist = typeof data.distanceKm === 'number' && data.distanceKm > 0 ? Number(data.distanceKm.toFixed(1)) : undefined;

    const fareEstimate = await this.estimateFare({
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      dropLat: data.dropLat,
      dropLng: data.dropLng,
      tripType: data.tripType,
      category: data.category,
      distanceKm: clientDist,
    });

    const finalDistanceKm = clientDist ?? fareEstimate.distanceKm;

    let discountAmount = 0.0;
    let finalEstimatedFare = fareEstimate.estimatedFare;

    if (data.couponCode) {
      const { couponsService } = await import('../coupons/coupons.service');
      const couponResult = await couponsService.validateAndApplyCoupon(
        data.couponCode,
        fareEstimate.estimatedFare
      );
      discountAmount = couponResult.discountAmount;
      finalEstimatedFare = couponResult.finalFare;
    }

    const bookingCode = `GC-${Math.floor(100000 + Math.random() * 900000)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Validate scheduled pickup time safely
    const isScheduledBooking = !!(data.scheduledAt && data.scheduledAt.trim().length > 0 && data.scheduledAt !== 'Pick-up now');
    let validatedScheduledAt: string | null = null;
    let scheduledDisplayStr: string | null = null;
    if (isScheduledBooking) {
      const parsedDate = parseScheduledPickupTime(data.scheduledAt);
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        throw new Error(`Invalid scheduled pickup time format: "${data.scheduledAt}". Please use standard ISO format.`);
      }
      if (parsedDate.getTime() <= Date.now()) {
        throw new Error('Scheduled pickup time must be in the future');
      }
      validatedScheduledAt = parsedDate.toISOString();
      scheduledDisplayStr = parsedDate.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      }) + ', ' + parsedDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata',
      });
    }

    // Preserve intermediate stops (support up to 4 stops)
    const rawStops = data.additionalStops || (Array.isArray(data.stops) ? data.stops : (data.stops?.additionalStops || []));
    const cleanStops: string[] = Array.isArray(rawStops)
      ? rawStops.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0).slice(0, 4)
      : [];

    const seatCap = data.seatCapacity || (data.requestedSeats?.includes('6') || data.requestedVehicle?.includes('6') ? 6 : 4);
    const reqVehicle = data.requestedVehicle || data.requestedSeats || data.carName || (seatCap === 6 ? '6 Seater Cab' : '4 Seater Cab');

    const finalTripType = standardizeTripType({
      customTripType: data.customTripType,
      tripType: data.tripType,
      distanceKm: finalDistanceKm,
    });
    const isElite = !!(
      data.isElite === true ||
      String(data.category).toUpperCase() === 'ELITE' ||
      String(reqVehicle).toLowerCase().includes('elite') ||
      String(data.carName).toLowerCase().includes('elite')
    );

    const ride = await prisma.$transaction(async (tx) => {
      if (data.couponCode) {
        const { couponsService } = await import('../coupons/coupons.service');
        await couponsService.consumeCoupon(data.couponCode, tx);
      }

      return tx.ride.create({
        data: {
          bookingCode,
          customerId,
          tripType: finalTripType.includes('Round Trip') ? 'ROUND_TRIP' : (finalDistanceKm > 25 ? 'OUTSTATION' : 'ONE_WAY'),
          status: 'SEARCHING',
          pickupLocation: data.pickupLocation,
          pickupAddress: data.pickupAddress,
          pickupLat: data.pickupLat,
          pickupLng: data.pickupLng,
          dropLocation: data.dropLocation,
          dropAddress: data.dropAddress,
          dropLat: data.dropLat,
          dropLng: data.dropLng,
          distanceKm: finalDistanceKm,
          estimatedFare: finalEstimatedFare,
          startOtp,
          paymentMethod: data.paymentMethod || 'CASH',
          stops: {
            ...(data.couponCode
              ? { couponCode: data.couponCode.trim().toUpperCase(), couponRestored: false }
              : {}),
            scheduledAt: validatedScheduledAt,
            scheduledDisplay: scheduledDisplayStr,
            isScheduled: isScheduledBooking,
            seatCapacity: seatCap,
            requestedVehicle: reqVehicle,
            customTripType: finalTripType,
            isElite: isElite,
            category: isElite ? 'ELITE' : (data.category || 'REGULAR'),
            additionalStops: cleanStops,
          },
          fareBreakdown: {
            create: {
              distanceKm: finalDistanceKm,
              pricePerKm: fareEstimate.pricePerKm,
              baseFare: fareEstimate.baseFare,
              driverBata: fareEstimate.driverBata,
              discountAmount,
              totalFare: finalEstimatedFare,
            },
          },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          fareBreakdown: true,
        },
      });
    });

    // In Admin-controlled dispatch, all requests (instant and scheduled)
    // are queued for Admin dispatch and availability validation.
    // Drivers receive assignment notifications ONLY after Admin assigns them.

    // Send instant booking confirmation with Pickup OTP to the customer
    notificationsService.sendToUser({
      userId: customerId,
      title: isScheduledBooking ? '📅 Ride Scheduled Successfully!' : '🚖 Cab Booking Confirmed!',
      message: isScheduledBooking
        ? `Your trip for ${scheduledDisplayStr || 'scheduled time'} is confirmed. Your Pickup OTP is ${startOtp}.`
        : `Your ride request (${bookingCode}) is confirmed. Your Pickup OTP is ${startOtp}.`,
      type: 'ride_created',
      data: {
        rideId: ride.id,
        bookingCode,
        startOtp,
        isScheduled: String(isScheduledBooking),
      },
    }).catch((e) => console.error('Customer ride creation notification error:', e));

    // Send notification to all admin users so it appears in Admin Notification Screen & Push
    notificationsService.sendToAdmins({
      title: isScheduledBooking ? '📅 New Scheduled Booking Request' : '🚖 New Ride Booking Request',
      message: `Booking #${bookingCode}: ${data.pickupLocation} ➔ ${data.dropLocation} (${data.requestedVehicle || data.carName || 'Cab'}) - ₹${finalEstimatedFare.toFixed(0)}`,
      type: 'ride_created',
      data: {
        rideId: ride.id,
        bookingCode,
        customerId,
        pickupLocation: data.pickupLocation,
        dropLocation: data.dropLocation,
        totalFare: String(finalEstimatedFare),
        isScheduled: String(isScheduledBooking),
      },
    }).catch((e) => console.error('Admin ride creation notification error:', e));

    return {
      ...ride,
      tripType: finalTripType,
      isElite,
      category: isElite ? 'ELITE' : (data.category || 'REGULAR'),
    };
  }

  /**
   * Driver accepts a ride
   */
  async acceptRide(driverUserId: string, rideId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      include: { assignedVehicle: true },
    });

    if (!driver || driver.approvalStatus !== 'APPROVED') {
      throw new Error('Driver is not verified or approved');
    }

    // Fix 3: Accept Ride Validation � check driver user isActive and vehicle status
    const driverUser = await prisma.user.findUnique({ where: { id: driverUserId }, select: { isActive: true } });
    if (!driverUser?.isActive) {
      throw new Error('Your driver account has been deactivated by Admin. Please contact support.');
    }

    if (driver.assignedVehicle && driver.assignedVehicle.status !== 'VERIFIED') {
      throw new Error(`Your assigned vehicle (${driver.assignedVehicle.model}) is currently ${driver.assignedVehicle.status.toLowerCase()} and cannot be used for rides. Please contact support.`);
    }

    // Unavailability Guard: cannot accept if driver or assigned vehicle is scheduled unavailable on this ride date
    const targetRideDateStr = unavailabilityService.normalizeDate(new Date());
    const isRideDateBlocked = await unavailabilityService.isUnavailable(
      driver.id,
      driver.assignedVehicleId,
      targetRideDateStr
    );
    if (isRideDateBlocked) {
      throw new Error(`Cannot accept ride: You or your vehicle are scheduled unavailable today (${targetRideDateStr}).`);
    }

    const ride = await prisma.ride.findFirst({
      where: {
        OR: [{ id: rideId }, { bookingCode: rideId }],
      },
    });
    if (!ride) throw new Error('Ride not found');

    // Strict Admin-Controlled Dispatch: Only the assigned driver can accept this ride
    if (!ride.driverId || ride.driverId !== driver.id) {
      throw new Error('Unauthorized: You are not the assigned driver for this ride');
    }

    if (ride.status !== 'SEARCHING' && !(ride.status === 'ACCEPTED' && ride.driverId === driver.id)) {
      throw new Error('Ride is no longer available');
    }

    const updatedRide = await prisma.ride.update({
      where: { id: ride.id },
      data: {
        driverId: driver.id,
        vehicleId: driver.assignedVehicleId || ride.vehicleId,
        status: 'ACCEPTED',
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

    // Notify Customer that driver accepted, prominently featuring Pickup OTP
    notificationsService.sendToUser({
      userId: ride.customerId,
      title: '✅ Ride Accepted by Driver!',
      message: `${updatedRide.driver?.user.name || 'Your driver'} is on the way. Your Pickup OTP is ${ride.startOtp}. Share with driver to start trip.`,
      type: 'ride_accepted',
      data: {
        rideId: ride.id,
        bookingCode: ride.bookingCode || '',
        startOtp: ride.startOtp,
      },
    }).catch((e) => console.error('Customer notification error:', e));

    return {
      ...updatedRide,
      assignedVehicleId: updatedRide.vehicleId || updatedRide.vehicle?.id || updatedRide.driver?.assignedVehicleId || null,
      assignedVehicleNumber: updatedRide.vehicle?.vehicleNumber || updatedRide.driver?.assignedVehicle?.vehicleNumber || null,
      assignedVehicleModel: updatedRide.vehicle?.model || updatedRide.driver?.assignedVehicle?.model || null,
    };
  }

  /**
   * Driver updates intermediate status: EN_ROUTE or ARRIVED, or cancel ride
   */
  async updateStatus(
    rideId: string,
    status: 'EN_ROUTE' | 'ARRIVED' | 'CANCELLED',
    actorRole: 'CUSTOMER' | 'DRIVER' | 'ADMIN',
    cancelReason?: string,
    driverUserId?: string
  ) {
    const allowedStatuses = ['EN_ROUTE', 'ARRIVED', 'CANCELLED'];
    if (!allowedStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Status update only permits EN_ROUTE, ARRIVED, or CANCELLED. Starting a ride requires customer OTP verification via /start.`);
    }

    const cleanRideId = String(rideId).trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanRideId);
    const ride = await prisma.ride.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: cleanRideId }] : []),
          { bookingCode: cleanRideId },
          { bookingCode: cleanRideId.replace(/^GC-/i, '') },
          { bookingCode: `GC-${cleanRideId.replace(/^GC-/i, '')}` },
        ],
      },
    });
    if (!ride) throw new Error('Ride not found');

    // Enforce driver ownership on intermediate status updates
    if (actorRole === 'DRIVER' && driverUserId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
      });
      if (!driver || ride.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }
    }

    // Idempotency: If ride is already cancelled, return cleanly without duplicate operations
    if (status === 'CANCELLED' && ride.status === 'CANCELLED') {
      return ride;
    }

    if (ride.status === 'COMPLETED') {
      throw new Error('Cannot change status of an already completed ride');
    }

    let updated: any;

    if (status === 'CANCELLED') {
      const metadata = (ride.stops as any) || {};
      const couponCode = metadata.couponCode;
      const alreadyRestored = metadata.couponRestored === true;

      updated = await prisma.$transaction(async (tx) => {
        // Idempotently restore coupon usage if not already restored
        if (couponCode && !alreadyRestored) {
          const { couponsService } = await import('../coupons/coupons.service');
          await couponsService.restoreCoupon(couponCode, tx);
        }

        const resolvedReason =
          cancelReason ||
          (actorRole === 'CUSTOMER'
            ? 'Cancelled by customer'
            : actorRole === 'DRIVER'
            ? 'Cancelled by driver'
            : 'Cancelled by admin');

        return tx.ride.update({
          where: { id: ride.id },
          data: {
            status: 'CANCELLED',
            cancelReason: resolvedReason,
            cancelledBy: actorRole.toLowerCase(),
            stops: couponCode ? { ...metadata, couponRestored: true } : ride.stops as any,
          },
          include: {
            customer: true,
            driver: { include: { user: true } },
          },
        });
      });
    } else {
      updated = await prisma.ride.update({
        where: { id: ride.id },
        data: { status },
        include: {
          customer: true,
          driver: { include: { user: true } },
        },
      });
    }

    // Notify other party
    if (status === 'ARRIVED') {
      const driverName = updated.driver?.user?.name || 'Your driver';
      notificationsService.sendToUser({
        userId: ride.customerId,
        title: '📍 Driver Has Arrived at Pickup!',
        message: `${driverName} has arrived at your pickup spot. Your Pickup OTP is ${ride.startOtp}. Share with driver to begin your trip.`,
        type: 'driver_arrived',
        data: {
          rideId: ride.id,
          bookingCode: ride.bookingCode || '',
          startOtp: ride.startOtp || '',
        },
      }).catch((e) => console.error(e));
    } else if (status === 'CANCELLED') {
      // Invalidate active ride location cache immediately
      locationCacheService.invalidateRideValidation(ride.id).catch(() => {});
      const recipientId = actorRole === 'DRIVER' ? ride.customerId : updated.driver?.userId;
      if (recipientId) {
        notificationsService.sendToUser({
          userId: recipientId,
          title: '❌ Ride Cancelled',
          message: cancelReason ? `Reason: ${cancelReason}` : 'Ride has been cancelled.',
          type: 'ride_cancelled',
          data: { rideId },
        }).catch((e) => console.error(e));
      }
      // Also notify admins
      notificationsService.sendToAdmins({
        title: '❌ Ride Booking Cancelled',
        message: `Booking #${ride.bookingCode || ride.id.slice(-6)} was cancelled by ${actorRole.toLowerCase()}.${cancelReason ? ` Reason: ${cancelReason}` : ''}`,
        type: 'ride_cancelled',
        data: { rideId: ride.id, bookingCode: ride.bookingCode || '', cancelledBy: actorRole },
      }).catch((e) => console.error('Admin ride cancellation notification error:', e));
    }

    return updated;
  }

  /**
   * Start ride using OTP verification
   */
  async startRide(rideId: string, enteredOtp: string, driverUserId?: string) {
    if (!enteredOtp || typeof enteredOtp !== 'string' || enteredOtp.trim().length === 0) {
      throw new Error('Start OTP is required');
    }

    const cleanRideId = String(rideId).trim();
    const ride = await prisma.ride.findFirst({
      where: {
        OR: [
          { id: cleanRideId },
          { bookingCode: cleanRideId },
          { bookingCode: cleanRideId.replace(/^GC-/i, '') },
          { id: cleanRideId.replace(/^GC-/i, '') },
        ],
      },
    });
    if (!ride) throw new Error('Ride not found');

    if (driverUserId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
      });
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      if (ride.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }
    }

    const validStatuses = ['ARRIVED'];
    if (!validStatuses.includes(ride.status)) {
      throw new Error(`Cannot start ride with current status: ${ride.status}. Driver must mark ARRIVED at pickup before verifying OTP and starting trip.`);
    }

    // Enforce scheduled trip start window (cannot start prematurely)
    const meta = (ride.stops as any) || {};
    const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
    if (isScheduled) {
      const scheduledTimeStr = meta.scheduledAt;
      if (!scheduledTimeStr || typeof scheduledTimeStr !== 'string' || scheduledTimeStr.trim().length === 0) {
        throw new Error('Scheduled ride is missing scheduled pickup time');
      }
      const scheduledDate = new Date(scheduledTimeStr.trim());
      if (isNaN(scheduledDate.getTime())) {
        throw new Error(`Invalid scheduled pickup time format: "${scheduledTimeStr}"`);
      }
      const now = new Date();
      const earliestAllowedStartTime = new Date(scheduledDate.getTime() - SCHEDULED_START_WINDOW_MINUTES * 60 * 1000);
      if (now < earliestAllowedStartTime) {
        throw new Error(`Scheduled ride cannot be started earlier than ${SCHEDULED_START_WINDOW_MINUTES} minutes before scheduled pickup time (${scheduledDate.toISOString()})`);
      }
    }

    // Require exact customer OTP verification (no hardcoded bypass values)
    if (ride.startOtp !== enteredOtp.trim()) {
      throw new Error('Invalid OTP. Please check with customer.');
    }

    const updated = await prisma.ride.update({
      where: { id: ride.id },
      data: {
        status: 'ONGOING',
        startedAt: new Date(),
      },
    });

    notificationsService.sendToUser({
      userId: ride.customerId,
      title: '🚗 Trip Started!',
      message: 'Have a safe journey with Golden Cabs.',
      type: 'trip_started',
      data: { rideId: ride.id },
    }).catch((e) => console.error(e));

    return updated;
  }

  /**
   * Complete ride, calculate final fare, and settle driver wallet atomically.
   * Payout Policy: Platform absorbs customer coupon discounts.
   * - CASH rides: Driver collects cash in hand from customer -> paymentStatus becomes PAID,
   *   and company commission is debited from driver wallet (can become negative dues).
   * - ONLINE rides:
   *     - If paymentStatus is already verified as PAID: driver wallet is credited with net earnings.
   *     - If paymentStatus is PENDING: ride completes, but paymentStatus REMAINS PENDING!
   *       Driver wallet is NEVER credited for uncollected funds.
   * - Switch to Cash: If customer original method was UPI/CARD but customer pays cash directly,
   *   switchToCash=true transitions method to CASH, marks PAID, and applies cash commission settlement.
   */
  async completeRide(rideId: string, options?: { switchToCash?: boolean }) {
    const updatedRide = await prisma.$transaction(async (tx) => {
      const cleanRideId = String(rideId).trim();
      const ride = await tx.ride.findFirst({
        where: {
          OR: [
            { id: cleanRideId },
            { bookingCode: cleanRideId },
            { bookingCode: cleanRideId.replace(/^GC-/i, '') },
            { id: cleanRideId.replace(/^GC-/i, '') },
          ],
        },
        include: {
          fareBreakdown: true,
          driver: { include: { wallet: true } },
        },
      });

      if (!ride) throw new Error('Ride not found');
      if (ride.status === 'COMPLETED') throw new Error('Ride is already completed');

      // Gross Fare Calculation: Total trip fare before promo discounts
      const customerPayable = ride.fareBreakdown ? ride.fareBreakdown.totalFare : ride.estimatedFare;
      const discountAmount = ride.fareBreakdown ? ride.fareBreakdown.discountAmount : 0;
      const grossTripFare = customerPayable + discountAmount;

      const finalFare = customerPayable;
      const completedAt = new Date();

      // Handle Switch to Cash option
      let effectivePaymentMethod = ride.paymentMethod;
      if (options?.switchToCash && effectivePaymentMethod !== 'CASH') {
        effectivePaymentMethod = 'CASH';
      }

      const isCash = effectivePaymentMethod === 'CASH';
      const isAlreadyPaid = ride.paymentStatus === 'PAID';

      // Financial Correctness Guard:
      // CASH: Driver collects cash in person at drop-off -> marks PAID
      // ONLINE: If verified as PAID beforehand -> remains PAID; if PENDING -> strictly remains PENDING!
      const finalPaymentStatus = isCash ? 'PAID' : (isAlreadyPaid ? 'PAID' : 'PENDING');

      const updated = await tx.ride.update({
        where: { id: ride.id },
        data: {
          status: 'COMPLETED',
          finalFare,
          completedAt,
          paymentMethod: effectivePaymentMethod,
          paymentStatus: finalPaymentStatus,
        },
        include: {
          customer: true,
          driver: { include: { user: true } },
          fareBreakdown: true,
        },
      });

      // Driver settlement: Uber/Rapido style
      // Handle Cash vs UPI/Online settlements with idempotency protection
      let driverWallet = ride.driver?.wallet;
      if (!driverWallet && ride.driverId) {
        driverWallet = await tx.wallet.findUnique({
          where: { driverId: ride.driverId },
        });
        if (!driverWallet) {
          driverWallet = await tx.wallet.create({
            data: {
              driverId: ride.driverId,
              balance: 0.0,
              lifetimeEarnings: 0.0,
              pendingWithdrawals: 0.0,
            },
          });
        }
      }

      if (driverWallet) {
        const existingTx = await tx.walletTransaction.findFirst({
          where: { referenceRideId: ride.id },
        });

        if (!existingTx) {
          const commissionRate = await platformSettingsService.getCommissionRate();
          const companyCommission = Math.round(grossTripFare * commissionRate * 100) / 100;
          const driverNetEarnings = Math.round((grossTripFare - companyCommission) * 100) / 100;
          const currentBalance = driverWallet.balance;

          if (isCash) {
            // Customer Cash Payment:
            // Driver collects full customer payment directly.
            // Deduct ONLY company commission from wallet balance as company dues (can become negative).
            // Driver earned net earnings in cash, so lifetimeEarnings reflects real net earnings.
            const newBalance = Math.round((currentBalance - companyCommission) * 100) / 100;
            await tx.wallet.update({
              where: { id: driverWallet.id },
              data: {
                balance: newBalance,
                lifetimeEarnings: { increment: driverNetEarnings },
              },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: driverWallet.id,
                amount: companyCommission,
                type: 'COMMISSION',
                status: 'COMPLETED',
                previousBalance: currentBalance,
                newBalance: newBalance,
                description: `Company commission due for cash trip ${ride.bookingCode} (Collected: ₹${customerPayable}, Commission: ₹${companyCommission})`,
                referenceRideId: ride.id,
              },
            });
          } else if (isAlreadyPaid) {
            // Customer UPI / Online Payment (Confirmed):
            // Company receives full online payment.
            // Driver net earnings credited to wallet balance (automatically offsetting any negative dues).
            const newBalance = Math.round((currentBalance + driverNetEarnings) * 100) / 100;
            await tx.wallet.update({
              where: { id: driverWallet.id },
              data: {
                balance: newBalance,
                lifetimeEarnings: { increment: driverNetEarnings },
              },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: driverWallet.id,
                amount: driverNetEarnings,
                type: 'EARNING',
                status: 'COMPLETED',
                previousBalance: currentBalance,
                newBalance: newBalance,
                description: `Earnings for trip ${ride.bookingCode} (Online: ₹${customerPayable}, Commission: ₹${companyCommission})`,
                referenceRideId: ride.id,
              },
            });
          } else {
            // Unpaid Online Ride:
            // Ride is completed, but customer has NOT paid online yet.
            // DO NOT credit driver wallet with unreceived funds.
            console.log(
              `[RideService] Ride ${ride.bookingCode} completed with pending online payment (Method: ${ride.paymentMethod}). Driver wallet not credited until payment verification.`
            );
          }
        }
      }

      // Update customer and driver total rides
      await tx.customerProfile.updateMany({
        where: { userId: ride.customerId },
        data: { totalRides: { increment: 1 } },
      });

      if (ride.driverId) {
        await tx.driverProfile.update({
          where: { id: ride.driverId },
          data: { totalRides: { increment: 1 } },
        });
      }

      return updated;
    });

    // Flush final driver location to database immediately upon trip completion
    if (updatedRide.driverId) {
      locationCacheService.flushDriverImmediately(updatedRide.driverId).catch(() => {});
    }

    // Invalidate active ride location cache immediately
    locationCacheService.invalidateRideValidation(updatedRide.id).catch(() => {});

    // Send notifications to Customer and Driver
    notificationsService.sendToUser({
      userId: updatedRide.customerId,
      title: '🏁 Trip Completed!',
      message: `Total Fare: ₹${updatedRide.finalFare}. Thank you for choosing Golden Cabs!`,
      type: 'trip_completed',
      data: { rideId: updatedRide.id, amount: String(updatedRide.finalFare) },
    }).catch((e) => console.error(e));

    if (updatedRide.driver?.userId) {
      const grossFare = (updatedRide.fareBreakdown?.totalFare || 0) + (updatedRide.fareBreakdown?.discountAmount || 0);
      const isCash = updatedRide.paymentMethod === 'CASH';
      const isPaid = updatedRide.paymentStatus === 'PAID';
      const commissionRate = await platformSettingsService.getCommissionRate();
      const commission = Math.round(grossFare * commissionRate * 100) / 100;
      const driverPay = Math.round((grossFare - commission) * 100) / 100;

      if (isCash) {
        notificationsService.sendToUser({
          userId: updatedRide.driver.userId,
          title: '💵 Cash Trip Completed!',
          message: `Collected ₹${updatedRide.finalFare} cash. Company commission ₹${commission} debited from wallet.`,
          type: 'wallet_debited',
          data: { rideId: updatedRide.id, commission: String(commission) },
        }).catch((e) => console.error(e));
      } else if (isPaid) {
        notificationsService.sendToUser({
          userId: updatedRide.driver.userId,
          title: '💰 Trip Earnings Credited!',
          message: `₹${driverPay} has been added to your wallet for trip ${updatedRide.bookingCode}.`,
          type: 'wallet_credited',
          data: { rideId: updatedRide.id, amount: String(driverPay) },
        }).catch((e) => console.error(e));
      } else {
        notificationsService.sendToUser({
          userId: updatedRide.driver.userId,
          title: '⏳ Trip Completed (Payment Pending)',
          message: `Trip ${updatedRide.bookingCode} completed. Online payment of ₹${updatedRide.finalFare} is pending customer confirmation.`,
          type: 'trip_completed',
          data: { rideId: updatedRide.id, amount: String(updatedRide.finalFare), paymentStatus: 'PENDING' },
        }).catch((e) => console.error(e));
      }
    }

    // Post-trip expiry check for DRIVE_ONLY drivers:
    // If the daily vehicle allocation expired while this trip was ongoing, unassign it now that trip has completed
    if (updatedRide.driverId) {
      vehiclesService
        .checkAndExpireDriverVehicle(updatedRide.driverId, { reason: 'post_trip_completion' })
        .catch((err) => console.error('[RideService] Post-trip vehicle expiry check error:', err));
    }

    return updatedRide;
  }

  async getRideById(rideId: string) {
    const cleanRideId = String(rideId).trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanRideId);
    const r = await prisma.ride.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: cleanRideId }] : []),
          { bookingCode: cleanRideId },
          { bookingCode: cleanRideId.replace(/^GC-/i, '') },
          { bookingCode: `GC-${cleanRideId.replace(/^GC-/i, '')}` },
        ],
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
    if (!r) return null;

    if (r.driver?.id) {
      try {
        const locMap = await locationCacheService.getLocationsForDrivers([r.driver.id]);
        const cachedLoc = locMap.get(r.driver.id);
        if (cachedLoc && cachedLoc.latitude != null && cachedLoc.longitude != null) {
          (r.driver as any).currentLatitude = cachedLoc.latitude;
          (r.driver as any).currentLongitude = cachedLoc.longitude;
          if (cachedLoc.heading != null) (r.driver as any).heading = cachedLoc.heading;
          if (cachedLoc.speed != null) (r.driver as any).speed = cachedLoc.speed;
          (r.driver as any).updatedAt = new Date(cachedLoc.updatedAt).toISOString();
        }
      } catch (locErr) {
        console.warn(`[getRideById] Failed to overlay cached location for driver ${r.driver.id}:`, locErr);
      }
    }

    const meta = (r.stops as any) || {};
    const finalTripType = standardizeTripType({
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
    return {
      ...r,
      assignedVehicleId: r.vehicleId || r.vehicle?.id || r.driver?.assignedVehicleId || null,
      assignedVehicleNumber: r.vehicle?.vehicleNumber || r.driver?.assignedVehicle?.vehicleNumber || null,
      assignedVehicleModel: r.vehicle?.model || r.driver?.assignedVehicle?.model || null,
      tripType: finalTripType,
      isElite,
      category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
    };
  }

  async getCustomerRides(customerId: string) {
    const rides = await prisma.ride.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        driver: {
          include: {
            user: { select: { name: true, phone: true } },
            assignedVehicle: true,
          },
        },
        fareBreakdown: true,
      },
    });

    return rides.map((r) => {
      const meta = (r.stops as any) || {};
      const finalTripType = standardizeTripType({
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
      return {
        ...r,
        tripType: finalTripType,
        isElite,
        category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
      };
    });
  }

  async getDriverRides(driverUserId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      include: {
        assignedVehicle: true,
        ownedVehicles: { select: { id: true } },
      },
    });
    if (!driver) return [];

    const ownedVehicleIds = driver.ownedVehicles?.map((v) => v.id) || [];

    const rides = await prisma.ride.findMany({
      where: {
        OR: [
          { driverId: driver.id },
          ...(ownedVehicleIds.length > 0 ? [{ vehicleId: { in: ownedVehicleIds } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        vehicle: true,
        fareBreakdown: true,
      },
    });

    return rides.map(({ startOtp, ...safeRide }) => {
      const meta = (safeRide.stops as any) || {};
      const finalTripType = standardizeTripType({
        customTripType: meta.customTripType,
        tripType: safeRide.tripType,
        distanceKm: safeRide.distanceKm,
      });
      const isElite = !!(
        meta.isElite ||
        meta.category === 'ELITE' ||
        meta.requestedVehicle?.toLowerCase().includes('elite') ||
        safeRide.tripType?.toLowerCase().includes('elite')
      );
      return {
        ...safeRide,
        assignedVehicleId: safeRide.vehicleId || safeRide.vehicle?.id || driver.assignedVehicleId || null,
        assignedVehicleNumber: safeRide.vehicle?.vehicleNumber || driver.assignedVehicle?.vehicleNumber || null,
        assignedVehicleModel: safeRide.vehicle?.model || driver.assignedVehicle?.model || null,
        tripType: finalTripType,
        isElite,
        category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
      };
    });
  }

  /**
   * Rides waiting for drivers to accept
   */
  async getAvailableRides(limit = 20, driverUserId?: string) {
    let driverProfileId: string | undefined;
    let driverAssignedVehicle: any = null;
    let ownedVehicleIds: string[] = [];
    if (driverUserId) {
      const dp = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
        select: {
          id: true,
          assignedVehicle: true,
          ownedVehicles: { select: { id: true } },
        },
      });
      driverProfileId = dp?.id;
      driverAssignedVehicle = dp?.assignedVehicle;
      ownedVehicleIds = dp?.ownedVehicles?.map((v) => v.id) || [];
      if (!driverProfileId) {
        // If driver profile does not exist, return empty array immediately
        return [];
      }
    }

    // Driver-specific assignments window: up to 24 hours
    const assignedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // CRITICAL: Unassigned rides (driverId == null) are NEVER sent to drivers.
    // Drivers only receive rides specifically assigned to them by Admin.
    const orConditions: any[] = [];
    if (driverProfileId) {
      orConditions.push({
        status: { in: [TripStatus.SEARCHING, TripStatus.ACCEPTED, TripStatus.EN_ROUTE, TripStatus.ARRIVED, TripStatus.ONGOING] },
        driverId: driverProfileId,
      });
      if (ownedVehicleIds.length > 0) {
        orConditions.push({
          status: { in: [TripStatus.SEARCHING, TripStatus.ACCEPTED, TripStatus.EN_ROUTE, TripStatus.ARRIVED, TripStatus.ONGOING] },
          vehicleId: { in: ownedVehicleIds },
        });
      }
    } else {
      // Internal or Admin view without driver context
      const freshnessCutoff = new Date(Date.now() - 30 * 60 * 1000);
      orConditions.push({ status: TripStatus.SEARCHING, createdAt: { gte: freshnessCutoff } });
      orConditions.push({ status: TripStatus.ACCEPTED, createdAt: { gte: freshnessCutoff } });
    }

    const rides = await prisma.ride.findMany({
      where: {
        AND: [
          { status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] } },
        ],
        OR: orConditions,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        vehicle: true,
        fareBreakdown: true,
      },
    });

    const filteredRides = rides.filter((r) => {
      const meta = (r.stops as any) || {};
      const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;
      // If it is an unassigned scheduled ride, DO NOT broadcast to general driver pool
      // Admin must assign a driver or vehicle first.
      if (isScheduled && !r.driverId && !r.vehicleId) {
        return false;
      }
      return true;
    });

    return filteredRides.map((r) => {
      const meta = (r.stops as any) || {};
      const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;
      const scheduledTimeStr = meta.scheduledAt ? String(meta.scheduledAt) : '';
      const finalTripType = standardizeTripType({
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

      return {
        id: r.id,
        bookingCode: r.bookingCode,
        customerName: r.customer?.name || 'Customer',
        customerPhone: r.customer?.phone || '',
        customerRating: 4.8,
        pickupLocation: r.pickupLocation,
        pickupAddress: r.pickupAddress || r.pickupLocation,
        dropLocation: r.dropLocation,
        dropAddress: r.dropAddress || r.dropLocation,
        distance: `${r.distanceKm} km`,
        distanceKm: r.distanceKm,
        estimatedFare: `₹ ${Math.round(r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0)}`,
        fareAmount: r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0,
        paymentMethod: r.paymentMethod,
        tripType: finalTripType,
        isElite,
        category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
        status: r.status,
        isScheduled,
        scheduledAt: scheduledTimeStr || null,
        date: scheduledTimeStr || (r.createdAt ? r.createdAt.toISOString() : new Date().toISOString()),
        time: scheduledTimeStr || (r.createdAt
          ? new Date(r.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : 'Now'),
        assignedVehicleId: r.vehicleId || r.vehicle?.id || driverAssignedVehicle?.id || null,
        assignedVehicleNumber: r.vehicle?.vehicleNumber || driverAssignedVehicle?.vehicleNumber || null,
        assignedVehicleModel: r.vehicle?.model || driverAssignedVehicle?.model || null,
        pickupLat: r.pickupLat,
        pickupLng: r.pickupLng,
        dropLat: r.dropLat,
        dropLng: r.dropLng,
        stops: meta.additionalStops || meta.stops || [],
        additionalStops: meta.additionalStops || [],
        createdAt: r.createdAt,
      };
    });
  }
}

export const ridesService = new RidesService();
