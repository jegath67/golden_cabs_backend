import { prisma } from '../../config/prisma';
import type { Prisma } from '../../generated/prisma/client';
import { standardizeTripType, StandardizedTripType } from '../../utils/trip-type.helper';
import { resolveRideIsElite, isVehicleLuxury } from '../../utils/ride-category.helper';
import { unavailabilityService } from '../unavailability/unavailability.service';
import { vehiclesService } from '../vehicles/vehicles.service';

export interface DriverAvailabilityResult {
  driverId: string;
  isAvailable: boolean;
  reasonCode?: string;
  reasonMessage?: string;
  pickupDistanceKm?: number;
  pickupEtaMinutes?: number;
  expectedFreeTime?: Date;
  activeTripId?: string;
  conflictingTripId?: string;
  driver?: any;
  vehicle?: any;
}

export interface RideEvaluationTarget {
  id: string;
  bookingCode?: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  distanceKm: number;
  tripType: StandardizedTripType;
  isScheduled: boolean;
  scheduledAt: Date | null;
  seatCapacity?: number;
  isElite?: boolean;
  category?: string;
  additionalStopsCount?: number;
}

export class DriverAvailabilityService {
  /**
   * Calculate distance between two coordinates using Haversine formula (KM)
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
    return Math.max(0.1, Math.round(dist * 10) / 10);
  }

  /**
   * Authoritative trip duration formula by canonical trip type
   *
   * 1. Local One Way (<= 25 km):
   *    - Avg city speed: 30 km/h (0.5 km/min)
   *    - Stops: 10 mins per intermediate stop
   *    - Min duration: 15 mins
   *    - Post-trip buffer: 10 mins
   *
   * 2. Local Round Trip (<= 25 km):
   *    - Both legs: distance * 2
   *    - Avg city speed: 30 km/h
   *    - Destination turnaround/halt: 15 mins
   *    - Stops: 10 mins per stop
   *    - Min duration: 30 mins
   *    - Post-trip buffer: 15 mins
   *
   * 3. Outstation One Way (> 25 km):
   *    - Avg highway speed: 50 km/h
   *    - Stops: 15 mins per stop
   *    - Min duration: 45 mins
   *    - Post-trip rest & return transit to base buffer: distance / 50 * 60 (min 30 mins)
   *
   * 4. Outstation Round Trip (> 25 km):
   *    - Both legs: distance * 2
   *    - Avg highway speed: 50 km/h
   *    - Destination customer wait/halt: 45 mins
   *    - Stops: 15 mins per stop
   *    - Min duration: 90 mins
   *    - Post-trip buffer: 30 mins
   */
  calculateTripDurationMinutes(params: {
    tripType: StandardizedTripType;
    distanceKm: number;
    additionalStopsCount?: number;
  }): { durationMinutes: number; safetyBufferMinutes: number } {
    const stops = params.additionalStopsCount || 0;
    const dist = Math.max(1, params.distanceKm);

    switch (params.tripType) {
      case 'Local One Way': {
        const driveMins = Math.round((dist / 30.0) * 60.0);
        const stopsMins = stops * 10;
        const durationMinutes = Math.max(15, driveMins + stopsMins);
        const safetyBufferMinutes = 10;
        return { durationMinutes, safetyBufferMinutes };
      }

      case 'Local Round Trip': {
        const roundDist = dist * 2;
        const driveMins = Math.round((roundDist / 30.0) * 60.0);
        const stopsMins = stops * 10;
        const haltMins = 15;
        const durationMinutes = Math.max(30, driveMins + stopsMins + haltMins);
        const safetyBufferMinutes = 15;
        return { durationMinutes, safetyBufferMinutes };
      }

      case 'Outstation One Way': {
        const driveMins = Math.round((dist / 50.0) * 60.0);
        const stopsMins = stops * 15;
        const durationMinutes = Math.max(45, driveMins + stopsMins);
        // Outstation return buffer: driver is outside territory and needs return transit time
        const returnTransitMins = Math.round((dist / 50.0) * 60.0);
        const safetyBufferMinutes = Math.max(30, Math.min(180, returnTransitMins));
        return { durationMinutes, safetyBufferMinutes };
      }

      case 'Outstation Round Trip': {
        const roundDist = dist * 2;
        const driveMins = Math.round((roundDist / 50.0) * 60.0);
        const stopsMins = stops * 15;
        const haltMins = 45;
        const durationMinutes = Math.max(90, driveMins + stopsMins + haltMins);
        const safetyBufferMinutes = 30;
        return { durationMinutes, safetyBufferMinutes };
      }

      default: {
        const driveMins = Math.round((dist / 30.0) * 60.0);
        return { durationMinutes: Math.max(15, driveMins), safetyBufferMinutes: 10 };
      }
    }
  }

  /**
   * Estimate transit time from Driver position (or previous drop) to New Pickup location
   */
  calculateTransitTimeMinutes(
    fromLat: number | null | undefined,
    fromLng: number | null | undefined,
    toLat: number,
    toLng: number
  ): { transitDistanceKm: number; transitMinutes: number } {
    if (fromLat === null || fromLat === undefined || fromLng === null || fromLng === undefined) {
      // Safe fallback if driver coordinates are unknown
      return { transitDistanceKm: 5.0, transitMinutes: 15 };
    }

    const distKm = this.calculateDistanceKm(fromLat, fromLng, toLat, toLng);
    // Speed: 30 km/h in city + 3 mins dispatch/traffic buffer. Minimum 5 mins.
    const transitMinutes = Math.max(5, Math.round((distKm / 30.0) * 60.0 + 3));
    return { transitDistanceKm: distKm, transitMinutes };
  }

  /**
   * Extract standardized ride evaluation model from database Ride record
   */
  extractRideTarget(ride: any): RideEvaluationTarget {
    const meta = (ride.stops as any) || {};
    const cleanStops = meta.additionalStops || meta.stops || [];
    const stopsCount = Array.isArray(cleanStops) ? cleanStops.length : 0;

    const stdTripType = standardizeTripType({
      customTripType: meta.customTripType,
      tripType: ride.tripType,
      distanceKm: ride.distanceKm,
    });

    const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
    let scheduledDate: Date | null = null;
    if (isScheduled && meta.scheduledAt) {
      const d = new Date(meta.scheduledAt);
      if (!isNaN(d.getTime())) {
        scheduledDate = d;
      }
    }

    const isElite = resolveRideIsElite({
      isElite: meta.isElite,
      category: meta.category,
      requestedVehicle: meta.requestedVehicle,
      carName: meta.carName,
      tripType: ride.tripType,
    });

    const seatCap = meta.seatCapacity || (meta.requestedSeats?.includes('6') || meta.requestedVehicle?.includes('6') ? 6 : 4);

    return {
      id: ride.id,
      bookingCode: ride.bookingCode,
      pickupLat: ride.pickupLat,
      pickupLng: ride.pickupLng,
      dropLat: ride.dropLat,
      dropLng: ride.dropLng,
      distanceKm: ride.distanceKm,
      tripType: stdTripType,
      isScheduled,
      scheduledAt: scheduledDate,
      seatCapacity: seatCap,
      isElite,
      category: isElite ? 'ELITE' : (meta.category || 'REGULAR'),
      additionalStopsCount: stopsCount,
    };
  }

  /**
   * Validate a single candidate driver against a target ride
   */
  async evaluateDriverAvailability(
    driverId: string,
    targetRide: RideEvaluationTarget,
    now: Date = new Date(),
    tx?: Prisma.TransactionClient
  ): Promise<DriverAvailabilityResult> {
    const db = tx ?? prisma;
    const wrap = (res: Omit<DriverAvailabilityResult, 'driverId'>): DriverAvailabilityResult => ({
      driverId,
      ...res,
    });

    const driver = await db.driverProfile.findUnique({
      where: { id: driverId },
      include: {
        user: { select: { id: true, name: true, phone: true, isActive: true } },
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });

    if (!driver) {
      return wrap({
        isAvailable: false,
        reasonCode: 'DRIVER_NOT_FOUND',
        reasonMessage: 'Driver profile does not exist.',
      });
    }

    // 1. Approval & Account Active
    if (driver.approvalStatus !== 'APPROVED') {
      return wrap({
        isAvailable: false,
        reasonCode: 'DRIVER_NOT_APPROVED',
        reasonMessage: `Driver is ${driver.approvalStatus.toLowerCase()}. Only approved drivers can be assigned.`,
        driver,
      });
    }

    if (!driver.user?.isActive) {
      return wrap({
        isAvailable: false,
        reasonCode: 'DRIVER_INACTIVE',
        reasonMessage: 'Driver user account is suspended or inactive.',
        driver,
      });
    }

    // 2. Persona & Vehicle Allocation
    let effectiveVehicle: any = driver.assignedVehicle;
    if (driver.personaType === 'OWN_VEHICLE') {
      const verifiedOwned = driver.ownedVehicles?.find((v) => v.status === 'VERIFIED');
      effectiveVehicle = driver.assignedVehicle || verifiedOwned;
    }

    if (!effectiveVehicle) {
      return wrap({
        isAvailable: false,
        reasonCode: 'NO_VEHICLE_ALLOCATED',
        reasonMessage: 'Driver does not have an active or verified vehicle allocated.',
        driver,
      });
    }

    // Fix 2: Dispatch Validation � only VERIFIED vehicles receive rides
    if (effectiveVehicle.status !== 'VERIFIED') {
      return wrap({
        isAvailable: false,
        reasonCode: 'VEHICLE_INACTIVE',
        reasonMessage: `Vehicle (${effectiveVehicle.model} - ${effectiveVehicle.vehicleNumber}) is ${effectiveVehicle.status.toLowerCase()}. Only verified vehicles can receive dispatches.`,
        driver,
        vehicle: effectiveVehicle,
      });
    }

    // Strict 4-Seater / 6-Seater Category & Seat Capacity Matching (Rules 1, 2, 3, 5)
    if (targetRide.seatCapacity) {
      if (targetRide.seatCapacity >= 6 && effectiveVehicle.seatCapacity < 6) {
        return wrap({
          isAvailable: false,
          reasonCode: 'SEATS_INSUFFICIENT',
          reasonMessage: `Ride requires 6 seats, but vehicle only has ${effectiveVehicle.seatCapacity} seats.`,
          driver,
          vehicle: effectiveVehicle,
        });
      }
      if (targetRide.seatCapacity <= 4 && effectiveVehicle.seatCapacity >= 6) {
        return wrap({
          isAvailable: false,
          reasonCode: 'CATEGORY_MISMATCH',
          reasonMessage: `4-Seater ride must match only 4-Seater vehicles; 6-Seater (${effectiveVehicle.seatCapacity} seats) cannot be substituted.`,
          driver,
          vehicle: effectiveVehicle,
        });
      }
      if (effectiveVehicle.seatCapacity < targetRide.seatCapacity) {
        return wrap({
          isAvailable: false,
          reasonCode: 'SEATS_INSUFFICIENT',
          reasonMessage: `Ride requires ${targetRide.seatCapacity} seats, but vehicle only has ${effectiveVehicle.seatCapacity} seats.`,
          driver,
          vehicle: effectiveVehicle,
        });
      }
    }

    // Check Elite / Luxury Category Match
    const isVehLuxury = isVehicleLuxury(effectiveVehicle);

    if (targetRide.isElite) {
      const isVehElite =
        isVehLuxury ||
        effectiveVehicle.category === 'PREMIUM' ||
        effectiveVehicle.brand.toLowerCase().includes('bmw') ||
        effectiveVehicle.brand.toLowerCase().includes('mercedes') ||
        effectiveVehicle.brand.toLowerCase().includes('audi') ||
        effectiveVehicle.model.toLowerCase().includes('elite');

      if (!isVehElite) {
        return wrap({
          isAvailable: false,
          reasonCode: 'CATEGORY_MISMATCH',
          reasonMessage: 'Ride requires an Elite / Luxury vehicle, but driver has a standard cab.',
          driver,
          vehicle: effectiveVehicle,
        });
      }
    } else if (isVehLuxury) {
      return wrap({
        isAvailable: false,
        reasonCode: 'CATEGORY_MISMATCH',
        reasonMessage: 'Luxury vehicle is reserved for Elite bookings and cannot be assigned to normal 4/6-Seater rides.',
        driver,
        vehicle: effectiveVehicle,
      });
    }

    // 3. Unavailability Schedule Guard (Immediate & Scheduled)
    const requestedPickupTime = (targetRide.isScheduled && targetRide.scheduledAt)
      ? targetRide.scheduledAt
      : now;

    const targetDateStr = unavailabilityService.normalizeDate(requestedPickupTime);
    const isDateBlocked = await unavailabilityService.isUnavailable(
      driver.id,
      effectiveVehicle.id,
      targetDateStr
    );

    if (isDateBlocked) {
      return wrap({
        isAvailable: false,
        reasonCode: 'SCHEDULED_UNAVAILABLE',
        reasonMessage: `Driver or vehicle is scheduled unavailable on ${targetDateStr}. No immediate or scheduled rides can be assigned.`,
        driver,
        vehicle: effectiveVehicle,
      });
    }

    const isInstantRide = !targetRide.isScheduled || requestedPickupTime.getTime() <= now.getTime() + 15 * 60 * 1000;

    if (isInstantRide) {
      if (!driver.isOnline || driver.shiftStatus === 'OFF_SHIFT') {
        return wrap({
          isAvailable: false,
          reasonCode: 'DRIVER_OFF_SHIFT',
          reasonMessage: 'Driver is currently offline or off-shift for immediate dispatch.',
          driver,
          vehicle: effectiveVehicle,
        });
      }

      if (driver.personaType === 'DRIVE_ONLY' && vehiclesService.isAllocationExpired(driver)) {
        return wrap({
          isAvailable: false,
          reasonCode: 'VEHICLE_ALLOCATION_EXPIRED',
          reasonMessage: 'Daily vehicle allocation for DRIVE_ONLY driver has expired. Vehicle re-allocation required.',
          driver,
          vehicle: effectiveVehicle,
        });
      }
    }

    // 4. Evaluate Active Ongoing / En-route Trip (Section 2.A)
    // A trip is currently active if it is ONGOING, EN_ROUTE, ARRIVED,
    // or an immediate ACCEPTED ride. Future scheduled rides are evaluated in Step 6.
    const activeCandidates = await db.ride.findMany({
      where: {
        driverId: driver.id,
        id: { not: targetRide.id },
        status: { in: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] },
      },
      include: { fareBreakdown: true },
    });

    const activeTrip = activeCandidates.find((r) => {
      if (r.status === 'ONGOING' || r.status === 'EN_ROUTE' || r.status === 'ARRIVED') {
        return true;
      }
      // If status === 'ACCEPTED', it is only active now if it is NOT a future scheduled ride
      const meta = (r.stops as any) || {};
      const isScheduled = !!meta.isScheduled && !!meta.scheduledAt;
      if (isScheduled) {
        const schedMs = new Date(meta.scheduledAt).getTime();
        return schedMs <= now.getTime() + 30 * 60 * 1000;
      }
      return true;
    });

    let driverEarliestFreeTime = new Date(now);
    let driverDepartureLat = driver.currentLatitude;
    let driverDepartureLng = driver.currentLongitude;

    if (activeTrip) {
      // If the target ride is immediate, a busy driver CANNOT take it
      if (isInstantRide) {
        return wrap({
          isAvailable: false,
          reasonCode: 'BUSY_CURRENT_TRIP',
          reasonMessage: `Driver is currently busy on trip ${activeTrip.bookingCode} (Status: ${activeTrip.status}).`,
          activeTripId: activeTrip.id,
          driver,
          vehicle: effectiveVehicle,
        });
      }

      // If the target ride is scheduled in the future:
      const activeTarget = this.extractRideTarget(activeTrip);
      const { durationMinutes: activeDurMins, safetyBufferMinutes: activeBufMins } =
        this.calculateTripDurationMinutes({
          tripType: activeTarget.tripType,
          distanceKm: activeTarget.distanceKm,
          additionalStopsCount: activeTarget.additionalStopsCount,
        });

      const activeStartTime = activeTrip.startedAt || activeTrip.createdAt || now;
      const expectedActiveCompletion = new Date(activeStartTime.getTime() + activeDurMins * 60 * 1000);

      // CRITICAL BUSINESS RULE 2.A:
      // Do not treat a driver as available merely because current time is past the scheduled end time
      // if the trip is still active!
      const safeActiveFreeTime = new Date(
        Math.max(
          now.getTime() + 15 * 60 * 1000, // At least 15 mins remaining if still active
          expectedActiveCompletion.getTime()
        )
      );

      // Post-trip turnaround buffer
      driverEarliestFreeTime = new Date(safeActiveFreeTime.getTime() + activeBufMins * 60 * 1000);

      // Driver's departure location after current trip will be the current trip's drop-off
      driverDepartureLat = activeTrip.dropLat;
      driverDepartureLng = activeTrip.dropLng;

      // Calculate transit from current drop-off to new ride pickup
      const { transitMinutes: transitToNewPickup, transitDistanceKm: transitDist } =
        this.calculateTransitTimeMinutes(
          driverDepartureLat,
          driverDepartureLng,
          targetRide.pickupLat,
          targetRide.pickupLng
        );

      const arrivalAtNewPickup = new Date(driverEarliestFreeTime.getTime() + transitToNewPickup * 60 * 1000);

      if (arrivalAtNewPickup.getTime() > requestedPickupTime.getTime()) {
        const diffMins = Math.round((arrivalAtNewPickup.getTime() - requestedPickupTime.getTime()) / 60000);
        return wrap({
          isAvailable: false,
          reasonCode: 'INSUFFICIENT_TIME_AFTER_ACTIVE_TRIP',
          reasonMessage: `Driver is on active trip ${activeTrip.bookingCode} and cannot reach pickup by ${requestedPickupTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (Short by ${diffMins} mins, travel distance: ${transitDist.toFixed(1)} km).`,
          expectedFreeTime: arrivalAtNewPickup,
          activeTripId: activeTrip.id,
          driver,
          vehicle: effectiveVehicle,
        });
      }
    }

    // 5. Calculate transit time from driver position to pickup (Section 2.C & 2.D)
    const { transitMinutes: pickupTransitMins, transitDistanceKm: pickupDistKm } =
      this.calculateTransitTimeMinutes(
        driverDepartureLat,
        driverDepartureLng,
        targetRide.pickupLat,
        targetRide.pickupLng
      );

    // If driver has no active trip and it's a scheduled ride, verify driver can reach pickup before requested time
    if (!activeTrip && targetRide.isScheduled) {
      const earliestArrival = new Date(now.getTime() + pickupTransitMins * 60 * 1000);
      if (earliestArrival.getTime() > requestedPickupTime.getTime()) {
        return wrap({
          isAvailable: false,
          reasonCode: 'CANNOT_REACH_PICKUP_IN_TIME',
          reasonMessage: `Pickup is at ${requestedPickupTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, but driver transit time is ${pickupTransitMins} mins from current location.`,
          pickupDistanceKm: pickupDistKm,
          pickupEtaMinutes: pickupTransitMins,
          driver,
          vehicle: effectiveVehicle,
        });
      }
    }

    // 6. Evaluate Target Ride Interval vs Existing Upcoming Assigned Trips (Section 2.B & 2.D)
    const { durationMinutes: targetDurMins, safetyBufferMinutes: targetBufMins } =
      this.calculateTripDurationMinutes({
        tripType: targetRide.tripType,
        distanceKm: targetRide.distanceKm,
        additionalStopsCount: targetRide.additionalStopsCount,
      });

    const targetStartMs = requestedPickupTime.getTime();
    const targetEndMs = targetStartMs + targetDurMins * 60 * 1000;

    // Fetch all existing upcoming / scheduled rides for this driver
    const upcomingRides = await db.ride.findMany({
      where: {
        driverId: driver.id,
        id: { notIn: [targetRide.id, ...(activeTrip ? [activeTrip.id] : [])] },
        status: { in: ['SEARCHING', 'ACCEPTED'] },
      },
      include: { fareBreakdown: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const upcoming of upcomingRides) {
      const uTarget = this.extractRideTarget(upcoming);
      const uPickupTime = (uTarget.isScheduled && uTarget.scheduledAt)
        ? uTarget.scheduledAt
        : upcoming.createdAt;

      const { durationMinutes: uDurMins, safetyBufferMinutes: uBufMins } =
        this.calculateTripDurationMinutes({
          tripType: uTarget.tripType,
          distanceKm: uTarget.distanceKm,
          additionalStopsCount: uTarget.additionalStopsCount,
        });

      const uStartMs = uPickupTime.getTime();
      const uEndMs = uStartMs + uDurMins * 60 * 1000;

      // Condition 1: Direct Time-Interval Overlap
      if (Math.max(targetStartMs, uStartMs) < Math.min(targetEndMs, uEndMs)) {
        return wrap({
          isAvailable: false,
          reasonCode: 'DIRECT_TIME_CONFLICT',
          reasonMessage: `Direct time conflict with upcoming trip ${upcoming.bookingCode} scheduled from ${uPickupTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
          conflictingTripId: upcoming.id,
          driver,
          vehicle: effectiveVehicle,
        });
      }

      // Condition 2: Target ride is BEFORE the upcoming trip
      if (targetStartMs < uStartMs) {
        // Driver must finish target ride, transit from target drop-off to upcoming pickup, plus buffer, before upcoming start
        const { transitMinutes: transitToUpcoming } = this.calculateTransitTimeMinutes(
          targetRide.dropLat,
          targetRide.dropLng,
          uTarget.pickupLat,
          uTarget.pickupLng
        );

        const requiredFreeBy = targetEndMs + (transitToUpcoming + targetBufMins) * 60 * 1000;
        if (requiredFreeBy > uStartMs) {
          const deficitMins = Math.round((requiredFreeBy - uStartMs) / 60000);
          return wrap({
            isAvailable: false,
            reasonCode: 'OVERLAPPING_UPCOMING_TRIP',
            reasonMessage: `New ride (${targetRide.tripType}) finishes too late for upcoming trip ${upcoming.bookingCode} (Short by ${deficitMins} mins including travel & buffer).`,
            conflictingTripId: upcoming.id,
            driver,
            vehicle: effectiveVehicle,
          });
        }
      }

      // Condition 3: Target ride is AFTER the upcoming trip
      if (targetStartMs > uStartMs) {
        // Upcoming trip must finish, transit from upcoming drop-off to target pickup, plus buffer, before target start
        const { transitMinutes: transitFromUpcoming } = this.calculateTransitTimeMinutes(
          uTarget.dropLat,
          uTarget.dropLng,
          targetRide.pickupLat,
          targetRide.pickupLng
        );

        const requiredFreeBy = uEndMs + (transitFromUpcoming + uBufMins) * 60 * 1000;
        if (requiredFreeBy > targetStartMs) {
          const deficitMins = Math.round((requiredFreeBy - targetStartMs) / 60000);
          return wrap({
            isAvailable: false,
            reasonCode: 'OVERLAPPING_UPCOMING_TRIP',
            reasonMessage: `Upcoming trip ${upcoming.bookingCode} will not finish in time before new ride pickup (Short by ${deficitMins} mins including travel & buffer).`,
            conflictingTripId: upcoming.id,
            driver,
            vehicle: effectiveVehicle,
          });
        }
      }
    }

    // All availability & time-conflict checks passed!
    return wrap({
      isAvailable: true,
      pickupDistanceKm: pickupDistKm,
      pickupEtaMinutes: pickupTransitMins,
      expectedFreeTime: new Date(targetEndMs + targetBufMins * 60 * 1000),
      driver,
      vehicle: effectiveVehicle,
    });
  }

  /**
   * Evaluate all candidate drivers for a ride request and rank them
   */
  async getCandidateDriversForRide(
    rideIdOrBookingCode: string
  ): Promise<{
    targetRide: RideEvaluationTarget;
    availableDrivers: DriverAvailabilityResult[];
    unavailableDrivers: DriverAvailabilityResult[];
  }> {
    const rawId = String(rideIdOrBookingCode).trim();
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
      throw new Error(`Ride ${rideIdOrBookingCode} not found`);
    }

    const targetRide = this.extractRideTarget(ride);

    const allApprovedDrivers = await prisma.driverProfile.findMany({
      where: {
        approvalStatus: 'APPROVED',
      },
      include: {
        user: { select: { id: true, name: true, phone: true, isActive: true } },
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });

    const evaluations: DriverAvailabilityResult[] = [];
    const now = new Date();

    for (const d of allApprovedDrivers) {
      const res = await this.evaluateDriverAvailability(d.id, targetRide, now);
      evaluations.push(res);
    }

    const availableDrivers = evaluations
      .filter((e) => e.isAvailable)
      .sort((a, b) => (a.pickupDistanceKm ?? 999) - (b.pickupDistanceKm ?? 999));

    const unavailableDrivers = evaluations
      .filter((e) => !e.isAvailable)
      .sort((a, b) => (a.pickupDistanceKm ?? 999) - (b.pickupDistanceKm ?? 999));

    return {
      targetRide,
      availableDrivers,
      unavailableDrivers,
    };
  }

  /**
   * Check live pickup-area availability for 4-seater and 6-seater vehicle categories.
   * Reuses the exact same evaluateDriverAvailability() engine used during assignment.
   */
  async checkCategoryAvailability(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat?: number;
    dropLng?: number;
    tripType?: string;
    customTripType?: string;
    isScheduled?: boolean;
    scheduledAt?: Date | null;
    tx?: Prisma.TransactionClient;
  }): Promise<{
    fourSeater: { available: boolean; count: number; nearestDistanceKm: number | null };
    sixSeater: { available: boolean; count: number; nearestDistanceKm: number | null };
    isScheduled: boolean;
  }> {
    const { pickupLat, pickupLng, dropLat, dropLng, tripType, customTripType, isScheduled, scheduledAt, tx } = params;
    const db = tx ?? prisma;

    const stdTripType = standardizeTripType({
      customTripType,
      tripType,
      distanceKm: 10,
    });

    const isSched = !!isScheduled && !!scheduledAt;

    // Create target evaluations for 4-seater and 6-seater
    const targetRide4: RideEvaluationTarget = {
      id: 'preview_4_seater',
      pickupLat,
      pickupLng,
      dropLat: dropLat ?? pickupLat,
      dropLng: dropLng ?? pickupLng,
      distanceKm: 10,
      tripType: stdTripType,
      isScheduled: isSched,
      scheduledAt: isSched ? scheduledAt : null,
      seatCapacity: 4,
      isElite: false,
      category: 'REGULAR',
    };

    const targetRide6: RideEvaluationTarget = {
      id: 'preview_6_seater',
      pickupLat,
      pickupLng,
      dropLat: dropLat ?? pickupLat,
      dropLng: dropLng ?? pickupLng,
      distanceKm: 10,
      tripType: stdTripType,
      isScheduled: isSched,
      scheduledAt: isSched ? scheduledAt : null,
      seatCapacity: 6,
      isElite: false,
      category: 'REGULAR',
    };

    const allApprovedDrivers = await db.driverProfile.findMany({
      where: {
        approvalStatus: 'APPROVED',
      },
      include: {
        user: { select: { id: true, name: true, phone: true, isActive: true } },
        assignedVehicle: true,
        ownedVehicles: true,
      },
    });

    let fourSeaterCount = 0;
    let sixSeaterCount = 0;
    let fourSeaterNearestDist: number | null = null;
    let sixSeaterNearestDist: number | null = null;
    const now = new Date();

    for (const d of allApprovedDrivers) {
      // 1. Evaluate 6-seater eligibility
      const res6 = await this.evaluateDriverAvailability(d.id, targetRide6, now, tx);
      if (res6.isAvailable) {
        sixSeaterCount++;
        const dist = res6.pickupDistanceKm ?? null;
        if (dist !== null && (sixSeaterNearestDist === null || dist < sixSeaterNearestDist)) {
          sixSeaterNearestDist = dist;
        }
      }

      // 2. Evaluate 4-seater eligibility (strictly 4-seater vehicles only)
      const res4 = await this.evaluateDriverAvailability(d.id, targetRide4, now, tx);
      if (res4.isAvailable) {
        fourSeaterCount++;
        const dist = res4.pickupDistanceKm ?? null;
        if (dist !== null && (fourSeaterNearestDist === null || dist < fourSeaterNearestDist)) {
          fourSeaterNearestDist = dist;
        }
      }
    }

    // For immediate availability, subtract unassigned immediate SEARCHING rides per category.
    // Rules 6-11:
    // - Assigned SEARCHING rides (driverId != null) are already excluded above and must NOT be double-counted.
    // - Scheduled rides do NOT consume immediate fleet capacity.
    // - Unassigned SEARCHING rides reserve capacity until Admin or Customer cancels.
    let netFourCount = fourSeaterCount;
    let netSixCount = sixSeaterCount;

    if (!isSched) {
      const openSearchingRides = await db.ride.findMany({
        where: {
          status: 'SEARCHING',
          driverId: null,
        },
        select: {
          id: true,
          tripType: true,
          stops: true,
        },
      });

      let openFourDemand = 0;
      let openSixDemand = 0;

      for (const r of openSearchingRides) {
        const meta = (r.stops && typeof r.stops === 'object') ? (r.stops as any) : {};
        const rIsScheduled =
          !!meta.isScheduled ||
          (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
        if (rIsScheduled) continue;

        const rIsElite = resolveRideIsElite({
          isElite: meta.isElite,
          category: meta.category,
          requestedVehicle: meta.requestedVehicle,
          carName: meta.carName,
          tripType: r.tripType,
        });
        if (rIsElite) continue;

        const rSeatCap = Number(meta.seatCapacity) || (
          String(meta.requestedSeats || meta.requestedVehicle || '').includes('6') ? 6 : 4
        );
        if (rSeatCap >= 6) {
          openSixDemand++;
        } else {
          openFourDemand++;
        }
      }

      netFourCount = Math.max(0, fourSeaterCount - openFourDemand);
      netSixCount = Math.max(0, sixSeaterCount - openSixDemand);
    }

    return {
      fourSeater: {
        available: netFourCount > 0,
        count: netFourCount,
        nearestDistanceKm: netFourCount > 0 ? fourSeaterNearestDist : null,
      },
      sixSeater: {
        available: netSixCount > 0,
        count: netSixCount,
        nearestDistanceKm: netSixCount > 0 ? sixSeaterNearestDist : null,
      },
      isScheduled: isSched,
    };
  }
}

export const driverAvailabilityService = new DriverAvailabilityService();
