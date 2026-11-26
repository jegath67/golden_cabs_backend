import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { platformSettingsService } from '../settings/platform-settings.service';
import { unavailabilityService } from '../unavailability/unavailability.service';
import { locationCacheService } from '../drivers/location-cache.service';
import { vehiclesService } from '../vehicles/vehicles.service';
import { driverAvailabilityService } from './driver-availability.service';
import { TripStatus } from '../../generated/prisma/client';
import { socketService } from '../socket/socket.service';
import { standardizeTripType } from '../../utils/trip-type.helper';
import {
  pricingSlabsService,
  computeCommissionSplit,
  normalizeCommissionPercent,
  getLedgerTxMapForRides,
  resolveDriverRideBreakdown,
} from '../pricing-slabs/pricing-slabs.service';

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
  customTripType?: string;
  category?: 'BUDGET' | 'PREMIUM' | 'LUXURY' | 'ELITE';
  vehicleType?: string;
  carName?: string;
  requestedVehicle?: string;
  requestedSeats?: string;
  seatCapacity?: number;
  isElite?: boolean;
  zone?: string;
  tollCharge?: number;
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

  // Reject strings that lack a recognizable month name or numeric date before appending currentYear
  // (V8's Date("not-a-valid-date 2026") otherwise silently resolves to Jan 1, 2026)
  const hasMonthOrDate =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(cleaned) ||
    /\d{1,4}[-/]\d{1,2}/.test(cleaned);
  if (!hasMonthOrDate) {
    return null;
  }

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
    const isRound =
      input.tripType === 'ROUND_TRIP' ||
      (input.customTripType || '').toLowerCase().includes('round');
    let distanceKm =
      typeof input.distanceKm === 'number' && input.distanceKm > 0
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

    const slabFare = await pricingSlabsService.calculateFareFromActiveSlab({
      distanceKm,
      vehicleType: input.vehicleType,
      carName: input.carName,
      requestedVehicle: input.requestedVehicle,
      requestedSeats: input.requestedSeats,
      seatCapacity: input.seatCapacity,
      category: input.category,
      isElite: input.isElite,
      customTripType: input.customTripType,
      tripType: input.tripType,
      zone: input.zone,
      tollCharge: input.tollCharge,
    });

    return {
      distanceKm: slabFare.distanceKm,
      includedKm: slabFare.includedKm,
      pricePerKm: slabFare.pricePerKm,
      baseFare: slabFare.baseFare,
      distanceCharge: slabFare.distanceCharge,
      tollCharge: slabFare.tollCharge,
      driverBata: slabFare.driverBata,
      estimatedFare: slabFare.estimatedFare,
      pricingSlabId: slabFare.pricingSlabId,
      commissionPercent: slabFare.commissionPercent,
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
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY' | 'ELITE';
    paymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'WALLET';
    couponCode?: string;
    scheduledAt?: string;
    requestedSeats?: string;
    seatCapacity?: number;
    requestedVehicle?: string;
    vehicleType?: string;
    zone?: string;
    carName?: string;
    tollCharge?: number;
    additionalStops?: string[];
    stops?: any;
    riderName?: string;
    riderPhone?: string;
    skipAvailabilityCheck?: boolean;
  }) {
    const clientDist = typeof data.distanceKm === 'number' && data.distanceKm > 0 ? Number(data.distanceKm.toFixed(1)) : undefined;
    const seatCapPre = data.seatCapacity || (data.requestedSeats?.includes('6') || data.requestedVehicle?.includes('6') ? 6 : 4);
    const reqVehiclePre = data.requestedVehicle || data.requestedSeats || data.carName || (seatCapPre === 6 ? '6 Seater Cab' : '4 Seater Cab');
    const isElitePre = !!(
      data.isElite === true ||
      String(data.category).toUpperCase() === 'ELITE' ||
      String(reqVehiclePre).toLowerCase().includes('elite') ||
      String(data.carName).toLowerCase().includes('elite')
    );

    const fareEstimate = await this.estimateFare({
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      dropLat: data.dropLat,
      dropLng: data.dropLng,
      tripType: data.tripType,
      customTripType: data.customTripType,
      category: data.category,
      vehicleType: data.vehicleType,
      carName: data.carName,
      requestedVehicle: reqVehiclePre,
      requestedSeats: data.requestedSeats,
      seatCapacity: seatCapPre,
      isElite: isElitePre,
      zone: data.zone,
      tollCharge: data.tollCharge,
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

    // Snapshot the active PricingSlab commission % determined at ride creation so future slab updates never mutate this ride.
    const initialCommissionSplit = computeCommissionSplit(
      finalEstimatedFare + discountAmount,
      fareEstimate.commissionPercent
    );

    const ride = await prisma.$transaction(async (tx) => {
      // Atomic concurrency guard for immediate bookings:
      // Acquire fixed two-integer PostgreSQL transaction-scoped advisory lock before
      // evaluating category availability + open SEARCHING demand.
      if (!isScheduledBooking && !data.skipAvailabilityCheck) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;

        const avail = await driverAvailabilityService.checkCategoryAvailability({
          pickupLat: data.pickupLat,
          pickupLng: data.pickupLng,
          dropLat: data.dropLat,
          dropLng: data.dropLng,
          tripType: data.tripType,
          customTripType: data.customTripType,
          isScheduled: false,
          scheduledAt: null,
          tx,
        });

        const isRequestedAvailable = seatCap >= 6 ? avail.sixSeater.available : avail.fourSeater.available;
        if (!isRequestedAvailable) {
          const err: any = new Error(
            seatCap >= 6
              ? '6-Seater cabs are currently not available in your pickup area. Please choose another option or try again shortly.'
              : '4-Seater cabs are currently not available in your pickup area. Please choose another option or try again shortly.'
          );
          err.statusCode = 409;
          err.code = 'CATEGORY_UNAVAILABLE';
          throw err;
        }
      }

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
            ...(data.zone ? { zone: data.zone } : {}),
            scheduledAt: validatedScheduledAt,
            scheduledDisplay: scheduledDisplayStr,
            isScheduled: isScheduledBooking,
            seatCapacity: seatCap,
            requestedVehicle: reqVehicle,
            customTripType: finalTripType,
            isElite: isElite,
            category: isElite ? 'ELITE' : (data.category || 'REGULAR'),
            additionalStops: cleanStops,
            ...(data.riderName && data.riderName !== 'For me' ? { riderName: String(data.riderName).trim() } : {}),
            ...(data.riderPhone ? { riderPhone: String(data.riderPhone).trim() } : {}),
          },
          fareBreakdown: {
            create: {
              distanceKm: finalDistanceKm,
              pricePerKm: fareEstimate.pricePerKm,
              baseFare: fareEstimate.baseFare,
              tollCharge: fareEstimate.tollCharge || 0,
              driverBata: fareEstimate.driverBata,
              discountAmount,
              totalFare: finalEstimatedFare,
              commissionPercent: initialCommissionSplit.commissionPercent,
              commissionAmount: initialCommissionSplit.commissionAmount,
              driverAmount: initialCommissionSplit.driverAmount,
              pricingSlabId: fareEstimate.pricingSlabId,
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

    // Send instant booking request receipt with Pickup OTP to the customer
    notificationsService.sendToUser({
      userId: customerId,
      title: isScheduledBooking ? '📅 Ride Scheduled Successfully!' : '🚖 Ride Request Received!',
      message: isScheduledBooking
        ? `Your trip for ${scheduledDisplayStr || 'scheduled time'} is confirmed. Your Pickup OTP is ${startOtp}.`
        : `Your ride request (${bookingCode}) has been received. Assigning nearby driver...`,
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
      riderName: (ride.stops as any)?.riderName || null,
      riderPhone: (ride.stops as any)?.riderPhone || null,
      passengerName: ((ride.stops as any)?.riderName && (ride.stops as any)?.riderName !== 'For me')
        ? (ride.stops as any)?.riderName
        : (ride.customer?.name || 'Customer'),
      passengerPhone: (ride.stops as any)?.riderPhone || ride.customer?.phone || '',
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

    const updatedRide = await prisma.$transaction(async (tx) => {
      const currentRide = await tx.ride.findFirst({
        where: {
          OR: [{ id: rideId }, { bookingCode: rideId }],
        },
      });
      if (!currentRide) throw new Error('Ride not found');

      // Strict Admin-Controlled Dispatch: Only the assigned driver can accept this ride
      if (!currentRide.driverId || currentRide.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }

      const meta = (currentRide.stops as any) || {};
      const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
      if (isScheduled && (currentRide.paymentStatus || '').toUpperCase() !== 'PAID') {
        throw new Error('Cannot accept an unpaid scheduled ride. Advance payment is required.');
      }

      if (currentRide.status !== 'SEARCHING' && !(currentRide.status === 'ACCEPTED' && currentRide.driverId === driver.id)) {
        throw new Error('Ride is no longer available');
      }

      // Assignment Expiry Guard: 120 seconds limit from assignment (immediate rides only)
      if (!isScheduled) {
        const assignedAtTime = meta.assignedAt ? new Date(meta.assignedAt).getTime() : (currentRide.updatedAt ? new Date(currentRide.updatedAt).getTime() : null);
        if (assignedAtTime && (Date.now() - assignedAtTime > 120000)) {
          throw new Error('Assignment expired: Driver offer has timed out (exceeded 120 seconds).');
        }
      }

      const isAlreadyAccepted = currentRide.status === 'ACCEPTED' && currentRide.driverId === driver.id;
      const initialAcceptedAt = isAlreadyAccepted && meta.acceptedAt ? meta.acceptedAt : new Date().toISOString();

      return tx.ride.update({
        where: { id: currentRide.id },
        data: {
          driverId: driver.id,
          vehicleId: driver.assignedVehicleId || currentRide.vehicleId,
          status: 'ACCEPTED',
          stops: {
            ...meta,
            acceptedAt: initialAcceptedAt,
            isDriverIdle: false,
          },
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

    // Broadcast socket event to tracking room & admin fleet room
    socketService.broadcastRideStatus(updatedRide.id, 'ACCEPTED', {
      driverId: driver.id,
      driverName: updatedRide.driver?.user?.name || 'Driver',
      vehicleModel: updatedRide.vehicle?.model || updatedRide.driver?.assignedVehicle?.model,
      vehicleNumber: updatedRide.vehicle?.vehicleNumber || updatedRide.driver?.assignedVehicle?.vehicleNumber,
    });

    // Notify Customer that driver accepted, prominently featuring Pickup OTP
    notificationsService.sendToUser({
      userId: updatedRide.customerId,
      title: '✅ Ride Accepted by Driver!',
      message: `${updatedRide.driver?.user.name || 'Your driver'} is on the way. Your Pickup OTP is ${updatedRide.startOtp}. Share with driver to start trip.`,
      type: 'ride_accepted',
      data: {
        rideId: updatedRide.id,
        bookingCode: updatedRide.bookingCode || '',
        startOtp: updatedRide.startOtp,
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
   * Driver declines/rejects a ride assignment.
   * Atomically records rejection, clears driverId, reverts to SEARCHING,
   * and notifies live tracking & admin dispatch.
   */
  async declineRide(driverUserId: string, rideId: string, reason?: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      include: { user: { select: { name: true, phone: true } } },
    });
    if (!driver) throw new Error('Driver profile not found');

    const driverName = driver.user?.name || 'Driver';
    const cleanRideId = String(rideId).trim().replace(/^#/, '');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanRideId);

    const updatedRide = await prisma.$transaction(async (tx) => {
      const ride = await tx.ride.findFirst({
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

      if (ride.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }

      if (ride.status !== 'SEARCHING') {
        throw new Error(`Cannot decline ride in ${ride.status} status`);
      }

      const meta = (ride.stops as any) || {};
      const rejectedList = Array.isArray(meta.rejectedDriverIds) ? [...meta.rejectedDriverIds] : [];
      if (!rejectedList.includes(driver.id)) {
        rejectedList.push(driver.id);
      }

      const existingRejections = Array.isArray(meta.rejections) ? [...meta.rejections] : [];
      existingRejections.push({
        driverId: driver.id,
        driverName,
        reason: reason || 'Declined by driver',
        declinedAt: new Date().toISOString(),
      });

      const updatedMeta = {
        ...meta,
        rejectedDriverIds: rejectedList,
        declineReason: reason || 'Declined by driver',
        declinedBy: driverName,
        declinedDriverId: driver.id,
        declinedAt: new Date().toISOString(),
        rejections: existingRejections,
      };
      delete (updatedMeta as any).assignedAt;
      delete (updatedMeta as any).assignmentExpiresAt;

      return tx.ride.update({
        where: { id: ride.id },
        data: {
          driverId: null,
          vehicleId: null,
          status: 'SEARCHING',
          stops: updatedMeta,
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          fareBreakdown: true,
        },
      });
    });

    socketService.broadcastRideStatus(updatedRide.id, 'SEARCHING', {
      declinedDriverId: driver.id,
      declinedDriverName: driverName,
      declineReason: reason || 'Declined by driver',
      reason: reason || 'Declined by driver',
      unassigned: true,
    });

    return {
      success: true,
      message: 'Ride assignment declined successfully. Reverted to searching.',
    };
  }

  /**
   * Calculate cancellation policy, eligible refund, and cancellation fees based on 3-tier rules:
   * Tier 1: Early Cancellation (>= 2h before scheduled pickup): 100% refund, ₹0 fee
   * Tier 2: Last-Minute Cancellation (< 2h before scheduled pickup): 50% refund, 50% fee
   * Tier 3: In-Transit / After Trip Start: 0% refund, 100% fee
   * Unpaid / Instant ride: ₹0 refund, ₹0 fee
   */
  calculateCancellationPolicy(ride: any): {
    isPaid: boolean;
    totalFare: number;
    eligibleRefund: number;
    cancellationFee: number;
    refundPercentage: number;
    policyTier: 'EARLY_CANCELLATION' | 'LAST_MINUTE_CANCELLATION' | 'IN_TRANSIT' | 'UNPAID_STANDARD';
    reason: string;
  } {
    const meta = (ride.stops as any) || {};
    const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
    const isPaid = (ride.paymentStatus || '').toUpperCase() === 'PAID';
    const totalFare = Number(ride.finalFare ?? ride.estimatedFare ?? (ride.fareBreakdown?.totalFare || 0));

    if (ride.status === 'ONGOING' || ride.startedAt != null) {
      return {
        isPaid,
        totalFare,
        eligibleRefund: 0,
        cancellationFee: totalFare,
        refundPercentage: 0,
        policyTier: 'IN_TRANSIT',
        reason: 'Trip is already in progress. No refund is permitted for in-transit cancellations.',
      };
    }

    if (!isPaid) {
      return {
        isPaid: false,
        totalFare,
        eligibleRefund: 0,
        cancellationFee: 0,
        refundPercentage: 0,
        policyTier: 'UNPAID_STANDARD',
        reason: 'Trip was not prepaid. No cancellation fee or refund applies.',
      };
    }

    if (isScheduled && meta.scheduledAt) {
      const scheduledTime = new Date(meta.scheduledAt).getTime();
      const now = Date.now();
      const diffHours = (scheduledTime - now) / (1000 * 60 * 60);

      // Early cancellation: 2 hours or more before scheduled pickup time
      if (diffHours >= 2) {
        return {
          isPaid: true,
          totalFare,
          eligibleRefund: totalFare,
          cancellationFee: 0,
          refundPercentage: 100,
          policyTier: 'EARLY_CANCELLATION',
          reason: 'Early cancellation (> 2 hours before scheduled pickup). 100% full advance refund.',
        };
      } else {
        // Last-minute cancellation: within 2 hours of scheduled pickup time
        const refundPercent = 50;
        const refundAmount = Math.round((totalFare * (refundPercent / 100)) * 100) / 100;
        const fee = Math.round((totalFare - refundAmount) * 100) / 100;
        return {
          isPaid: true,
          totalFare,
          eligibleRefund: refundAmount,
          cancellationFee: fee,
          refundPercentage: refundPercent,
          policyTier: 'LAST_MINUTE_CANCELLATION',
          reason: 'Last-minute cancellation (< 2 hours before scheduled pickup). 50% refund, 50% cancellation fee.',
        };
      }
    }

    // Instant prepaid ride cancelled before start
    return {
      isPaid: true,
      totalFare,
      eligibleRefund: totalFare,
      cancellationFee: 0,
      refundPercentage: 100,
      policyTier: 'EARLY_CANCELLATION',
      reason: 'Prepaid ride cancelled before driver started trip. 100% full refund.',
    };
  }

  /**
   * Fetch cancellation quote for a ride (used by customer app before confirming cancellation)
   */
  async getCancellationQuote(rideIdentifier: string) {
    const cleanId = String(rideIdentifier || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
    const ride = await prisma.ride.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: cleanId }] : []),
          { bookingCode: cleanId },
          { bookingCode: cleanId.replace(/^GC-/i, '') },
          { bookingCode: `GC-${cleanId.replace(/^GC-/i, '')}` },
        ],
      },
      include: {
        fareBreakdown: true,
      },
    });

    if (!ride) {
      throw new Error('Ride not found');
    }

    return this.calculateCancellationPolicy(ride);
  }

  /**
   * Driver updates intermediate status: EN_ROUTE or ARRIVED, or cancel ride
   */
  async updateStatus(
    rideId: string,
    status: 'EN_ROUTE' | 'ARRIVED' | 'CANCELLED',
    actorRole: 'CUSTOMER' | 'DRIVER' | 'ADMIN',
    cancelReason?: string,
    actorUserId?: string
  ) {
    const allowedStatuses = ['EN_ROUTE', 'ARRIVED', 'CANCELLED'];
    if (!allowedStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Status update only permits EN_ROUTE, ARRIVED, or CANCELLED. Starting a ride requires customer OTP verification via /start.`);
    }

    const cleanRideId = String(rideId).trim().replace(/^#/, '');
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

    // Enforce actor authorization
    if (actorRole === 'CUSTOMER' && actorUserId) {
      if (ride.customerId !== actorUserId) {
        throw new Error('Unauthorized: You are not authorized to modify or cancel this booking');
      }
    } else if (actorRole === 'DRIVER' && actorUserId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: actorUserId },
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

    if (status === 'CANCELLED' && ride.status === 'ONGOING') {
      throw new Error('Cannot cancel a ride that is already in progress');
    }

    let updated: any;

    if (status === 'CANCELLED') {
      updated = await prisma.$transaction(async (tx) => {
        // 1. Acquire pessimistic row-level lock inside transaction to eliminate race conditions
        const locked = await tx.$queryRaw<any[]>`
          SELECT "id" FROM "Ride"
          WHERE "id" = ${cleanRideId}
             OR "bookingCode" = ${cleanRideId}
             OR "bookingCode" = ${`GC-${cleanRideId.replace(/^GC-/i, '')}`}
             OR "bookingCode" = ${cleanRideId.replace(/^GC-/i, '')}
          FOR UPDATE
        `;

        if (!locked.length) {
          throw new Error('Ride not found');
        }

        const freshRide = await tx.ride.findUnique({
          where: { id: locked[0].id },
          include: {
            customer: true,
            fareBreakdown: true,
            driver: { include: { user: true, wallet: true } },
          },
        });

        if (!freshRide) {
          throw new Error('Ride not found');
        }

        // 2. Strict authorization re-check on authoritative fresh state
        if (actorRole === 'CUSTOMER' && actorUserId) {
          if (freshRide.customerId !== actorUserId) {
            throw new Error('Unauthorized: You are not authorized to modify or cancel this booking');
          }
        } else if (actorRole === 'DRIVER' && actorUserId) {
          const driver = await tx.driverProfile.findUnique({
            where: { userId: actorUserId },
          });
          if (!driver || freshRide.driverId !== driver.id) {
            throw new Error('Unauthorized: You are not the assigned driver for this ride');
          }
        }

        // 3. Idempotency guard: If ride is ALREADY cancelled, return immediately
        if (freshRide.status === 'CANCELLED') {
          return freshRide;
        }

        if (freshRide.status === 'COMPLETED') {
          throw new Error('Cannot change status of an already completed ride');
        }

        if (freshRide.status === 'ONGOING') {
          throw new Error('Cannot cancel a ride that is already in progress');
        }

        const metadata = (freshRide.stops as any) || {};
        const couponCode = metadata.couponCode;
        const alreadyRestored = metadata.couponRestored === true;

        // 4. Calculate authoritative cancellation policy and eligible refund
        // Strictly scope zero customer fee and zero driver compensation to ADMIN cancellations
        const isPrepaid = (freshRide.paymentStatus || '').toUpperCase() === 'PAID';
        const totalFareAmount = Number(freshRide.finalFare || freshRide.estimatedFare || freshRide.fareBreakdown?.totalFare || 0);

        const quote = actorRole === 'ADMIN'
          ? {
              isPaid: isPrepaid,
              totalFare: totalFareAmount,
              eligibleRefund: isPrepaid ? totalFareAmount : 0,
              cancellationFee: 0,
              refundPercentage: 100,
              policyTier: 'ADMIN_CANCELLATION',
              reason: 'Admin cancelled ride due to operational / driver delay. Customer cancellation fee is waived (0%) and 100% full advance refund is authorized.',
            }
          : this.calculateCancellationPolicy(freshRide);

        // 5. Restore coupon idempotently if applicable
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

        // 6. Calculate 70% Driver Compensation and 30% Platform Share
        let driverCompensation = 0;
        let platformShare = quote.cancellationFee;

        if (quote.cancellationFee > 0 && freshRide.driverId) {
          driverCompensation = Math.round(quote.cancellationFee * 0.70 * 100) / 100;
          platformShare = Math.round((quote.cancellationFee - driverCompensation) * 100) / 100;
        }

        // 7. Update FareBreakdown so admin financial aggregations immediately account for the 30% platform share
        await tx.fareBreakdown.upsert({
          where: { rideId: freshRide.id },
          update: {
            totalFare: quote.cancellationFee,
            commissionAmount: platformShare,
            driverAmount: driverCompensation,
          },
          create: {
            rideId: freshRide.id,
            distanceKm: freshRide.distanceKm || 0,
            pricePerKm: 0,
            baseFare: quote.cancellationFee,
            totalFare: quote.cancellationFee,
            commissionAmount: platformShare,
            driverAmount: driverCompensation,
          },
        });

        // 8. If driver compensation applies, record in Driver Wallet & Ledger idempotently
        if (driverCompensation > 0 && freshRide.driverId) {
          const existingCompensation = await tx.walletTransaction.findFirst({
            where: {
              wallet: { driverId: freshRide.driverId },
              description: { contains: `booking #${freshRide.bookingCode}` },
            },
          });

          if (!existingCompensation) {
            const driverWallet = await tx.wallet.upsert({
              where: { driverId: freshRide.driverId },
              create: {
                driverId: freshRide.driverId,
                balance: driverCompensation,
                lifetimeEarnings: driverCompensation,
              },
              update: {
                balance: { increment: driverCompensation },
                lifetimeEarnings: { increment: driverCompensation },
              },
            });

            await tx.walletTransaction.create({
              data: {
                walletId: driverWallet.id,
                amount: driverCompensation,
                type: 'ADJUSTMENT',
                status: 'COMPLETED',
                description: `Cancellation compensation for booking #${freshRide.bookingCode} (70% driver share)`,
              },
            });
          }
        }

        // 9. If ride was prepaid, auto-create a RefundRequest record with the calculated eligible amount
        if (quote.isPaid && quote.eligibleRefund > 0) {
          const existingRefund = await tx.refundRequest.findUnique({
            where: { rideId: freshRide.id },
          });

          if (!existingRefund) {
            await tx.refundRequest.create({
              data: {
                rideId: freshRide.id,
                customerId: freshRide.customerId,
                reason: actorRole === 'ADMIN'
                  ? `[ADMIN_CANCELLATION] Admin cancelled ride (${resolvedReason}). Full refund request created (pending gateway settlement).`
                  : `[${quote.policyTier}] ${quote.reason} (Customer cancelled: ${resolvedReason})`,
                amount: quote.eligibleRefund,
                status: 'SUBMITTED',
                adminRemarks: actorRole === 'ADMIN'
                  ? `100% full refund of ₹${quote.eligibleRefund} authorized per Admin operational cancellation. Payment gateway processing pending settlement.`
                  : (quote.cancellationFee > 0
                      ? `Cancellation fee deducted: ₹${quote.cancellationFee} (Driver 70%: ₹${driverCompensation}, Platform 30%: ₹${platformShare}). Eligible Refund: ₹${quote.eligibleRefund} (${quote.refundPercentage}%).`
                      : `100% full refund of ₹${quote.eligibleRefund} authorized per early cancellation policy.`),
              },
            });
          }
        }

        // 10. Update ride status to CANCELLED and store full cancellation accounting
        const cancelledRide = await tx.ride.update({
          where: { id: freshRide.id },
          data: {
            status: 'CANCELLED',
            cancelReason: resolvedReason,
            cancelledBy: actorRole.toLowerCase(),
            stops: {
              ...(couponCode ? { ...metadata, couponRestored: true } : metadata),
              cancellationQuote: quote,
              cancellationAccounting: {
                totalFare: quote.totalFare,
                eligibleRefund: quote.eligibleRefund,
                cancellationFee: quote.cancellationFee,
                driverCompensation,
                platformShare,
                refundPercentage: quote.refundPercentage,
                cancelledAt: new Date().toISOString(),
              },
            },
          },
          include: {
            customer: true,
            driver: { include: { user: true } },
          },
        });

        return cancelledRide;
      });
    } else {
      const existingMeta = (ride.stops && typeof ride.stops === 'object') ? (ride.stops as any) : {};
      updated = await prisma.ride.update({
        where: { id: ride.id },
        data: {
          status,
          stops: {
            ...existingMeta,
            isDriverIdle: false,
            ...(status === 'EN_ROUTE' ? { enRouteAt: new Date().toISOString() } : {}),
            ...(status === 'ARRIVED' ? { arrivedAt: new Date().toISOString() } : {}),
          },
        },
        include: {
          customer: true,
          driver: { include: { user: true } },
        },
      });
    }

    // Broadcast status change via Socket.IO
    socketService.broadcastRideStatus(updated.id, status, {
      driverId: updated.driverId,
      status,
      cancelReason: status === 'CANCELLED' ? (updated.cancelReason || cancelReason) : undefined,
    });

    // Notify other party
    if (status === 'EN_ROUTE') {
      const driverName = updated.driver?.user?.name || 'Your driver';
      notificationsService.sendToUser({
        userId: ride.customerId,
        title: '🚖 Driver is on the way!',
        message: `${driverName} is navigating to your pickup location. Track your ride live in the app.`,
        type: 'driver_arriving',
        data: {
          rideId: ride.id,
          bookingCode: ride.bookingCode || '',
          startOtp: ride.startOtp || '',
        },
      }).catch((e) => console.error(e));
    } else if (status === 'ARRIVED') {
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
      if (actorRole === 'ADMIN') {
        if (updated.driver?.userId) {
          notificationsService.sendToUser({
            userId: updated.driver.userId,
            title: '❌ Ride Cancelled by Admin',
            message: cancelReason ? `Booking #${ride.bookingCode || ride.id.slice(-6)} cancelled: ${cancelReason}` : 'Ride has been cancelled by Admin.',
            type: 'ride_cancelled',
            data: { rideId },
          }).catch((e) => console.error(e));
        }
        if (ride.customerId) {
          notificationsService.sendToUser({
            userId: ride.customerId,
            title: '❌ Ride Cancelled',
            message: cancelReason ? `Booking #${ride.bookingCode || ride.id.slice(-6)} cancelled: ${cancelReason}` : 'Your ride has been cancelled by Admin. Any prepaid amount will be refunded.',
            type: 'ride_cancelled',
            data: { rideId },
          }).catch((e) => console.error(e));
        }
      } else {
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

    const cleanRideId = String(rideId).trim().replace(/^#/, '');
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

    socketService.broadcastRideStatus(updated.id, 'ONGOING', {
      startedAt: updated.startedAt,
      driverId: updated.driverId,
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
      const cleanRideId = String(rideId).trim().replace(/^#/, '');
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

      // Use frozen ride-creation commission % when available; fallback to global setting only for pre-migration rides.
      const fallbackGlobalPercent = await platformSettingsService.getCommissionPercent();
      const appliedCommissionPercent =
        ride.fareBreakdown?.commissionPercent != null
          ? normalizeCommissionPercent(ride.fareBreakdown.commissionPercent, fallbackGlobalPercent)
          : normalizeCommissionPercent(fallbackGlobalPercent, 20.0);
      const {
        commissionAmount: companyCommission,
        driverAmount: driverNetEarnings,
      } = computeCommissionSplit(grossTripFare, appliedCommissionPercent);

      // Persist exact settled commission & driver net amounts on FareBreakdown atomically.
      const savedFareBreakdown = await tx.fareBreakdown.upsert({
        where: { rideId: ride.id },
        update: {
          totalFare: finalFare,
          commissionPercent: appliedCommissionPercent,
          commissionAmount: companyCommission,
          driverAmount: driverNetEarnings,
        },
        create: {
          rideId: ride.id,
          distanceKm: ride.distanceKm || 0,
          pricePerKm: 0,
          baseFare: finalFare,
          discountAmount,
          totalFare: finalFare,
          commissionPercent: appliedCommissionPercent,
          commissionAmount: companyCommission,
          driverAmount: driverNetEarnings,
        },
      });
      updated.fareBreakdown = savedFareBreakdown;

      // Settle driver wallet atomically & idempotently (supports both CASH dues and verified PAID UPI/Online credits)
      await this.settleCompletedRideWalletInTx(tx, {
        rideId: ride.id,
        bookingCode: ride.bookingCode,
        driverId: ride.driverId,
        paymentMethod: effectivePaymentMethod,
        paymentStatus: finalPaymentStatus,
        customerPayable,
        companyCommission,
        driverNetEarnings,
        appliedCommissionPercent,
      });

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

    // Broadcast status change via Socket.IO
    socketService.broadcastRideStatus(updatedRide.id, 'COMPLETED', {
      finalFare: updatedRide.finalFare,
      completedAt: updatedRide.completedAt,
      driverId: updatedRide.driverId,
    });

    // Send notifications to Customer and Driver
    notificationsService.sendToUser({
      userId: updatedRide.customerId,
      title: '🏁 Trip Completed!',
      message: `Total Fare: ₹${updatedRide.finalFare}. Thank you for choosing Golden Cabs!`,
      type: 'trip_completed',
      data: {
        rideId: updatedRide.id,
        bookingCode: updatedRide.bookingCode || '',
        amount: String(updatedRide.finalFare),
      },
    }).catch((e) => console.error(e));

    if (updatedRide.driver?.userId) {
      const grossFare = (updatedRide.fareBreakdown?.totalFare || 0) + (updatedRide.fareBreakdown?.discountAmount || 0);
      const isCash = updatedRide.paymentMethod === 'CASH';
      const isPaid = updatedRide.paymentStatus === 'PAID';
      const fallbackPercent = await platformSettingsService.getCommissionPercent();
      const split = computeCommissionSplit(
        grossFare,
        updatedRide.fareBreakdown?.commissionPercent ?? fallbackPercent
      );
      const commission = updatedRide.fareBreakdown?.commissionAmount ?? split.commissionAmount;
      const driverPay = updatedRide.fareBreakdown?.driverAmount ?? split.driverAmount;

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

  /**
   * Idempotent, row-locked wallet settlement helper shared by completeRide & delayed UPI verification.
   */
  async settleCompletedRideWalletInTx(
    tx: any,
    params: {
      rideId: string;
      bookingCode: string;
      driverId?: string | null;
      paymentMethod: string;
      paymentStatus: string;
      customerPayable: number;
      companyCommission: number;
      driverNetEarnings: number;
      appliedCommissionPercent: number;
    }
  ): Promise<{ settled: boolean; type?: 'COMMISSION' | 'EARNING'; driverNetEarnings: number; companyCommission: number }> {
    const {
      rideId,
      bookingCode,
      driverId,
      paymentMethod,
      paymentStatus,
      customerPayable,
      companyCommission,
      driverNetEarnings,
      appliedCommissionPercent,
    } = params;

    if (!driverId) {
      return { settled: false, driverNetEarnings, companyCommission };
    }

    const isCash = paymentMethod === 'CASH';
    const isPaid = paymentStatus === 'PAID';
    if (!isCash && !isPaid) {
      console.log(
        `[RideService] Ride ${bookingCode} completed with pending online payment (Method: ${paymentMethod}). Driver wallet not credited until payment verification.`
      );
      return { settled: false, driverNetEarnings, companyCommission };
    }

    // Ensure wallet row exists, then acquire exclusive row lock on Wallet
    let wallet = await tx.wallet.findUnique({ where: { driverId } });
    if (!wallet) {
      wallet = await tx.wallet.create({
        data: {
          driverId,
          balance: 0.0,
          lifetimeEarnings: 0.0,
          pendingWithdrawals: 0.0,
        },
      });
    }
    const lockedWallets = await tx.$queryRaw<any[]>`
      SELECT * FROM "Wallet" WHERE "id" = ${wallet.id} FOR UPDATE
    `;
    const liveWallet = lockedWallets[0] || wallet;

    // Strict idempotency: never create duplicate settlement entry for a ride
    const existingSettlement = await tx.walletTransaction.findFirst({
      where: {
        referenceRideId: rideId,
        type: { in: ['COMMISSION', 'EARNING'] },
      },
    });
    if (existingSettlement) {
      return { settled: false, driverNetEarnings, companyCommission };
    }

    const currentBalance = Math.round(Number(liveWallet.balance) * 100) / 100;

    if (isCash) {
      const newBalance = Math.round((currentBalance - companyCommission) * 100) / 100;
      await tx.wallet.update({
        where: { id: liveWallet.id },
        data: {
          balance: newBalance,
          lifetimeEarnings: Math.round((Number(liveWallet.lifetimeEarnings) + driverNetEarnings) * 100) / 100,
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: liveWallet.id,
          amount: companyCommission,
          type: 'COMMISSION',
          status: 'COMPLETED',
          previousBalance: currentBalance,
          newBalance,
          description: `Company commission due for cash trip ${bookingCode} (Collected: ₹${customerPayable}, Commission: ₹${companyCommission} @ ${appliedCommissionPercent}%)`,
          referenceRideId: rideId,
        },
      });
      return { settled: true, type: 'COMMISSION', driverNetEarnings, companyCommission };
    }

    // Confirmed ONLINE / UPI payment
    const newBalance = Math.round((currentBalance + driverNetEarnings) * 100) / 100;
    await tx.wallet.update({
      where: { id: liveWallet.id },
      data: {
        balance: newBalance,
        lifetimeEarnings: Math.round((Number(liveWallet.lifetimeEarnings) + driverNetEarnings) * 100) / 100,
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: liveWallet.id,
        amount: driverNetEarnings,
        type: 'EARNING',
        status: 'COMPLETED',
        previousBalance: currentBalance,
        newBalance,
        description: `Earnings for trip ${bookingCode} (Online: ₹${customerPayable}, Commission: ₹${companyCommission} @ ${appliedCommissionPercent}%)`,
        referenceRideId: rideId,
      },
    });
    return { settled: true, type: 'EARNING', driverNetEarnings, companyCommission };
  }

  async getRideById(rideId: string) {
    const cleanRideId = String(rideId).trim().replace(/^#/, '');
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
        review: true,
        paymentTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
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
    const txMap = await getLedgerTxMapForRides([r.id]);
    const breakdown = resolveDriverRideBreakdown(r, txMap.get(r.id));
    const latestGatewayTx = r.paymentTransactions?.[0] || null;

    return {
      ...r,
      ...breakdown,
      gatewayOrderId: latestGatewayTx?.razorpayOrderId || meta.gatewayOrderId || null,
      gatewayPaymentId: latestGatewayTx?.razorpayPaymentId || meta.gatewayPaymentId || null,
      gatewayStatus: latestGatewayTx?.status || r.paymentStatus,
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

    const txMap = await getLedgerTxMapForRides(rides.map((r) => r.id));

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
      const breakdown = resolveDriverRideBreakdown(safeRide, txMap.get(safeRide.id));

      return {
        ...safeRide,
        ...breakdown,
        assignedVehicleId: safeRide.vehicleId || safeRide.vehicle?.id || driver.assignedVehicleId || null,
        assignedVehicleNumber: safeRide.vehicle?.vehicleNumber || driver.assignedVehicle?.vehicleNumber || null,
        assignedVehicleModel: safeRide.vehicle?.model || driver.assignedVehicle?.model || null,
        riderName: meta.riderName || null,
        riderPhone: meta.riderPhone || null,
        passengerName: (meta.riderName && meta.riderName !== 'For me') ? meta.riderName : (safeRide.customer?.name || 'Customer'),
        passengerPhone: meta.riderPhone || safeRide.customer?.phone || '',
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

      // Expired SEARCHING assignments are not returned as valid assigned offers
      if (r.status === TripStatus.SEARCHING) {
        if (meta.assignmentExpiresAt) {
          const expiresAtTime = new Date(meta.assignmentExpiresAt).getTime();
          if (!isNaN(expiresAtTime) && expiresAtTime <= Date.now()) {
            return false;
          }
        }
        // Prevent the same timed-out driver from immediately receiving the same offer again,
        // UNLESS they have been actively reassigned to it with a valid unexpired assignment window
        if (driverProfileId && Array.isArray(meta.timeoutDriverIds) && meta.timeoutDriverIds.includes(driverProfileId)) {
          const isActivelyAssigned = r.driverId === driverProfileId && (!meta.assignmentExpiresAt || new Date(meta.assignmentExpiresAt).getTime() > Date.now());
          if (!isActivelyAssigned) {
            return false;
          }
        }
      }

      return true;
    });

    const txMap = await getLedgerTxMapForRides(filteredRides.map((r) => r.id));

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
      const breakdown = resolveDriverRideBreakdown(r, txMap.get(r.id));

      return {
        id: r.id,
        bookingCode: r.bookingCode,
        customerName: r.customer?.name || 'Customer',
        customerPhone: r.customer?.phone || '',
        riderName: meta.riderName || null,
        riderPhone: meta.riderPhone || null,
        passengerName: (meta.riderName && meta.riderName !== 'For me') ? meta.riderName : (r.customer?.name || 'Customer'),
        passengerPhone: meta.riderPhone || r.customer?.phone || '',
        customerRating: 4.8,
        pickupLocation: r.pickupLocation,
        pickupAddress: r.pickupAddress || r.pickupLocation,
        dropLocation: r.dropLocation,
        dropAddress: r.dropAddress || r.dropLocation,
        distance: `${r.distanceKm} km`,
        estimatedFare: `₹ ${Math.round(r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0)}`,
        fareAmount: r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0,
        fareBreakdown: r.fareBreakdown,
        ...breakdown,
        paymentMethod: r.paymentMethod,
        paymentStatus: r.paymentStatus,
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
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : (r.createdAt ? r.createdAt.toISOString() : null),
        assignedAt: meta.assignedAt || null,
        assignmentExpiresAt: meta.assignmentExpiresAt || null,
      };
    });
  }
}

export const ridesService = new RidesService();
