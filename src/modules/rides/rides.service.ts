import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
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
  async estimateFare(input: EstimateFareInput) {
    const distanceKm = this.calculateDistanceKm(
      input.pickupLat,
      input.pickupLng,
      input.dropLat,
      input.dropLng
    );

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
    const fareEstimate = await this.estimateFare({
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      dropLat: data.dropLat,
      dropLng: data.dropLng,
      tripType: data.tripType,
      category: data.category,
    });

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
      distanceKm: fareEstimate.distanceKm,
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
          tripType: finalTripType.includes('Round Trip') ? 'ROUND_TRIP' : (fareEstimate.distanceKm > 25 ? 'OUTSTATION' : 'ONE_WAY'),
          status: 'SEARCHING',
          pickupLocation: data.pickupLocation,
          pickupAddress: data.pickupAddress,
          pickupLat: data.pickupLat,
          pickupLng: data.pickupLng,
          dropLocation: data.dropLocation,
          dropAddress: data.dropAddress,
          dropLat: data.dropLat,
          dropLng: data.dropLng,
          distanceKm: fareEstimate.distanceKm,
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
              distanceKm: fareEstimate.distanceKm,
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
        vehicleId: driver.assignedVehicleId,
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

    return updatedRide;
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

        return tx.ride.update({
          where: { id: ride.id },
          data: {
            status: 'CANCELLED',
            cancelReason,
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
   * Complete ride, calculate final fare, and credit driver wallet atomically.
   * Payout Policy: Platform absorbs customer coupon discounts.
   * Driver receives 80% commission based on the Gross Trip Fare.
   */
  async completeRide(rideId: string) {
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

      const updated = await tx.ride.update({
        where: { id: ride.id },
        data: {
          status: 'COMPLETED',
          finalFare,
          completedAt,
          paymentStatus: 'PAID',
        },
        include: {
          customer: true,
          driver: { include: { user: true } },
          fareBreakdown: true,
        },
      });

      // Credit driver's wallet: 80% of Gross Trip Fare (Platform absorbs discount subsidy)
      if (ride.driver?.wallet) {
        const driverEarnings = Math.round(grossTripFare * 0.8 * 100) / 100;
        await tx.wallet.update({
          where: { id: ride.driver.wallet.id },
          data: {
            balance: { increment: driverEarnings },
            lifetimeEarnings: { increment: driverEarnings },
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: ride.driver.wallet.id,
            amount: driverEarnings,
            type: 'EARNING',
            status: 'COMPLETED',
            description: `Earnings for trip ${ride.bookingCode} (Gross: ₹${grossTripFare}, Subsidy: ₹${discountAmount})`,
            referenceRideId: ride.id,
          },
        });
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
      const driverPay = Math.round(grossFare * 0.8 * 100) / 100;
      notificationsService.sendToUser({
        userId: updatedRide.driver.userId,
        title: '💰 Trip Earnings Credited!',
        message: `₹${driverPay} has been added to your wallet for trip ${updatedRide.bookingCode}.`,
        type: 'wallet_credited',
        data: { rideId: updatedRide.id },
      }).catch((e) => console.error(e));
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
    const driver = await prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (!driver) return [];

    const rides = await prisma.ride.findMany({
      where: { driverId: driver.id },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
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
    if (driverUserId) {
      const dp = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
        select: { id: true },
      });
      driverProfileId = dp?.id;
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
        status: TripStatus.SEARCHING,
        driverId: driverProfileId,
        updatedAt: { gte: assignedCutoff },
      });
      orConditions.push({
        status: TripStatus.ACCEPTED,
        driverId: driverProfileId,
        updatedAt: { gte: assignedCutoff },
      });
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
        fareBreakdown: true,
      },
    });

    const filteredRides = rides.filter((r) => {
      const meta = (r.stops as any) || {};
      const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;
      // If it is an unassigned scheduled ride, DO NOT broadcast to general driver pool
      // Admin must assign a driver first.
      if (isScheduled && !r.driverId) {
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
