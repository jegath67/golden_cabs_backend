import { randomUUID } from 'crypto';
import { vehiclesService } from '../vehicles/vehicles.service';
import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { socketService } from '../socket/socket.service';
import { TripStatus } from '../../generated/prisma/client';
import { driverAvailabilityService } from '../rides/driver-availability.service';
import { standardizeTripType } from '../../utils/trip-type.helper';

interface SchedulerStatus {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunDate: string | null;
  lastResetCount: number;
  lastSkippedCount: number;
  nextScheduledMidnightIST: string;
}

class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDate: string | null = null;
  private lastRunAt: string | null = null;
  private lastResetCount = 0;
  private lastSkippedCount = 0;
  private isProcessing = false;
  private isCheckingExpiredRides = false;
  private isCheckingExpiredAssignments = false;
  private isCheckingDriverIdleDelays = false;
  private isCheckingUnassignedSearching = false;

  /**
   * Initialize the scheduler at server boot
   */
  init() {
    if (this.timer) return;

    const { istDate } = this.getCurrentIST();
    // Default lastRunDate to today so it only triggers at upcoming midnight, not on midday reboot
    this.lastRunDate = istDate;

    console.log(`[SchedulerService] Initialized. Background tasks armed for vehicle reset, scheduled trip auto-expiry & driver assignment expiry.`);

    // Layer 2: Run server-startup catch-up check to clean any expired allocations from previous days
    this.runStartupCatchUpReset();

    // Check every 30 seconds for responsive 120s driver assignment timeouts & scheduled checks
    this.timer = setInterval(() => {
      this.checkAndRunMidnightReset();
      this.checkAndExpireUnassignedScheduledRides();
      this.checkAndExpireDriverAssignments();
      this.checkDriverIdleDelays();
      this.checkUnassignedSearchingDelays();
    }, 30 * 1000);

    // Initial check in case server started precisely at 00:00 or pending expired rides exist
    this.checkAndRunMidnightReset();
    this.checkAndExpireUnassignedScheduledRides();
    this.checkAndExpireDriverAssignments();
    this.checkDriverIdleDelays();
    this.checkUnassignedSearchingDelays();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrentIST(): { istDate: string; istTime: string; hours: number; minutes: number } {
    const now = new Date();
    const istDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

    const istTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const [hoursStr, minutesStr] = istTime.split(':');
    return {
      istDate,
      istTime,
      hours: parseInt(hoursStr, 10),
      minutes: parseInt(minutesStr, 10),
    };
  }

  /**
   * Layer 2 Catch-up: Run on server startup to clean any expired allocations from previous days
   */
  async runStartupCatchUpReset() {
    try {
      console.log(`[SchedulerService] Running server-startup catch-up check for expired DRIVE_ONLY allocations...`);
      const result = await vehiclesService.resetDailyDriveOnlyAllocations();
      console.log(`[SchedulerService] Startup catch-up reset finished: ${result.resetCount} reset, ${result.skippedCount} skipped (active rides).`);
    } catch (err) {
      console.error(`[SchedulerService] Error running startup catch-up reset:`, err);
    }
  }

  /**
   * Runs vehicle reset if midnight (00:00 - 00:05 IST) has arrived for a new day
   */
  async checkAndRunMidnightReset() {
    if (this.isProcessing) return;

    const { istDate, hours, minutes } = this.getCurrentIST();

    // Trigger window: 00:00 to 00:05 IST
    const isMidnightWindow = hours === 0 && minutes <= 5;

    if (isMidnightWindow && this.lastRunDate !== istDate) {
      this.isProcessing = true;
      try {
        console.log(`[SchedulerService] Midnight IST triggered for date: ${istDate}. Executing daily reset.`);
        const result = await vehiclesService.resetDailyDriveOnlyAllocations();
        this.lastRunDate = istDate;
        this.lastRunAt = new Date().toISOString();
        this.lastResetCount = result.resetCount;
        this.lastSkippedCount = result.skippedCount;
      } catch (err) {
        console.error('[SchedulerService] Error running midnight reset:', err);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  /**
   * Auto-cancels unassigned scheduled rides if:
   * 1. 30 minutes have elapsed since booking creation (createdAt + 30m) without driver assignment.
   * 2. The scheduled pickup time has arrived/passed without driver assignment.
   * Sends push notification to the customer informing them of the auto-cancellation.
   */
  async checkAndExpireUnassignedScheduledRides() {
    if (this.isCheckingExpiredRides) return;
    this.isCheckingExpiredRides = true;

    try {
      const now = new Date();

      // Fetch unassigned rides in SEARCHING or ACCEPTED status
      const candidateRides = await prisma.ride.findMany({
        where: {
          driverId: null,
          status: { in: [TripStatus.SEARCHING, TripStatus.ACCEPTED] },
        },
        include: {
          customer: true,
        },
      });

      for (const ride of candidateRides) {
        const meta = (ride.stops as any) || {};
        const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);

        if (!isScheduled) {
          continue;
        }

        const couponCode = meta.couponCode;
        const alreadyRestored = meta.couponRestored === true;

        const createdAtTime = ride.createdAt ? new Date(ride.createdAt).getTime() : 0;
        const isPaid = (ride.paymentStatus || '').toUpperCase() === 'PAID';
        const isOver15MinsFromCreation = createdAtTime > 0 && (now.getTime() - createdAtTime) >= 15 * 60 * 1000;
        const isOver30MinsFromCreation = createdAtTime > 0 && (now.getTime() - createdAtTime) >= 30 * 60 * 1000;

        let isPastPickup = false;
        if (meta.scheduledAt) {
          const sDate = new Date(meta.scheduledAt);
          if (!isNaN(sDate.getTime()) && sDate.getTime() <= now.getTime()) {
            isPastPickup = true;
          }
        }

        // 1. Abandoned unpaid scheduled booking: expire after 15 minutes of non-payment
        if (!isPaid) {
          if (!isOver15MinsFromCreation && !isPastPickup) {
            continue;
          }

          const cancelReason = isPastPickup
            ? 'Auto-cancelled: Scheduled pickup time arrived before advance payment was completed'
            : 'Auto-cancelled: Scheduled booking checkout abandoned (payment not completed within 15 minutes)';

          console.log(`[SchedulerService] Auto-cancelling abandoned unpaid scheduled ride ${ride.bookingCode || ride.id}. Reason: ${cancelReason}`);

          await prisma.$transaction(async (tx) => {
            if (couponCode && !alreadyRestored) {
              try {
                const { couponsService } = await import('../coupons/coupons.service');
                await couponsService.restoreCoupon(couponCode, tx);
              } catch (couponErr) {
                console.error(`[SchedulerService] Failed to restore coupon ${couponCode}:`, couponErr);
              }
            }

            await tx.ride.update({
              where: { id: ride.id },
              data: {
                status: TripStatus.CANCELLED,
                cancelReason,
                cancelledBy: 'SYSTEM',
                stops: couponCode ? { ...meta, couponRestored: true } : meta,
              },
            });
          });

          continue;
        }

        // 2. Paid scheduled booking: expire if unassigned past 30m or past pickup time, and issue full refund
        if (!isOver30MinsFromCreation && !isPastPickup) {
          continue;
        }

        const cancelReason = isOver30MinsFromCreation
          ? 'Auto-cancelled: Driver not assigned within 30 minutes of booking request'
          : 'Auto-cancelled: Scheduled pickup time has passed without driver assignment';

        console.log(`[SchedulerService] Auto-cancelling scheduled ride ${ride.bookingCode || ride.id}. Reason: ${cancelReason}`);

        const totalFare = Number(ride.finalFare ?? ride.estimatedFare ?? (ride as any).fareBreakdown?.totalFare ?? 0);

        await prisma.$transaction(async (tx) => {
          if (couponCode && !alreadyRestored) {
            try {
              const { couponsService } = await import('../coupons/coupons.service');
              await couponsService.restoreCoupon(couponCode, tx);
            } catch (couponErr) {
              console.error(`[SchedulerService] Failed to restore coupon ${couponCode}:`, couponErr);
            }
          }

          await tx.ride.update({
            where: { id: ride.id },
            data: {
              status: TripStatus.CANCELLED,
              cancelReason,
              cancelledBy: 'SYSTEM',
              stops: couponCode ? { ...meta, couponRestored: true } : meta,
            },
          });

          // Automatically create 100% full RefundRequest for customer of expired paid scheduled ride
          if (totalFare > 0) {
            const existingRefund = await tx.refundRequest.findUnique({
              where: { rideId: ride.id },
            });

            if (!existingRefund) {
              await tx.refundRequest.create({
                data: {
                  rideId: ride.id,
                  customerId: ride.customerId,
                  reason: `[SYSTEM_EXPIRED] ${cancelReason}`,
                  amount: totalFare,
                  status: 'SUBMITTED',
                  adminRemarks: '100% full refund authorized: System auto-cancelled scheduled trip due to unassigned driver / expired pickup.',
                },
              });
            }
          }
        });

        // Send Push Notification to customer
        try {
          await notificationsService.sendToUser({
            userId: ride.customerId,
            title: '❌ Scheduled Ride Cancelled',
            message: `Your scheduled booking (${ride.bookingCode || 'Trip'}) was cancelled as no driver was assigned within 30 minutes. Any payment or coupons have been refunded.`,
            type: 'ride_cancelled',
            data: {
              rideId: ride.id,
              bookingCode: ride.bookingCode || '',
              reason: cancelReason,
            },
          });
        } catch (notifErr) {
          console.error(`[SchedulerService] Failed to send cancel notification for ride ${ride.id}:`, notifErr);
        }
      }
    } catch (err) {
      console.error('[SchedulerService] Error running checkAndExpireUnassignedScheduledRides:', err);
    } finally {
      this.isCheckingExpiredRides = false;
    }
  }

  /**
   * Auto-releases expired driver assignments (120-second timeout)
   * If a ride is in SEARCHING status, has an assigned driver, and stops.assignmentExpiresAt <= now:
   * 1. Re-verifies state atomically in database transaction (ensuring status is still SEARCHING and driverId still matches).
   * 2. Clears driverId and vehicleId, reverting to unassigned SEARCHING state.
   * 3. Cleans up assignmentExpiresAt and records driver in timeoutDriverIds.
   * 4. Broadcasts realtime status transition to live fleet and customer rooms.
   */
  async checkAndExpireDriverAssignments() {
    if (this.isCheckingExpiredAssignments) return;
    this.isCheckingExpiredAssignments = true;

    try {
      const now = new Date();

      // Find candidate rides: SEARCHING with an assigned driver
      const candidateRides = await prisma.ride.findMany({
        where: {
          status: TripStatus.SEARCHING,
          driverId: { not: null },
        },
        select: {
          id: true,
          bookingCode: true,
          driverId: true,
          vehicleId: true,
          stops: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      for (const ride of candidateRides) {
        if (!ride.driverId) continue;

        const meta = (ride.stops && typeof ride.stops === 'object') ? (ride.stops as any) : {};
        const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
        if (isScheduled) {
          // Scheduled advance bookings are unaffected by the 120s immediate driver assignment timeout
          continue;
        }

        if (!meta.assignmentExpiresAt) {
          // Do not expire rides without a valid assignment expiry timestamp
          continue;
        }

        const expiresAtTime = new Date(meta.assignmentExpiresAt).getTime();
        if (isNaN(expiresAtTime) || expiresAtTime > now.getTime()) {
          // Not expired yet
          continue;
        }

        const targetDriverId = ride.driverId;
        const bookingDisplay = ride.bookingCode || ride.id;

        console.log(`[SchedulerService] Assignment expired for ride ${bookingDisplay} (Driver: ${targetDriverId}). Releasing assignment back to dispatch pool.`);

        // Atomic transaction with race protection
        const releaseSucceeded = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;

          const freshRide = await tx.ride.findUnique({
            where: { id: ride.id },
            select: { id: true, status: true, driverId: true, stops: true },
          });

          if (!freshRide) return false;

          // Strict verification: Ride must STILL be in SEARCHING and STILL assigned to the same driver
          if (freshRide.status !== TripStatus.SEARCHING || freshRide.driverId !== targetDriverId) {
            console.log(`[SchedulerService] Concurrency detected for ride ${bookingDisplay}: Driver ${targetDriverId} is no longer assigned or status changed to ${freshRide.status}. Skipping release.`);
            return false;
          }

          const existingStops = (freshRide.stops && typeof freshRide.stops === 'object') ? { ...(freshRide.stops as any) } : {};
          const { assignedAt, assignmentExpiresAt, ...cleanedStops } = existingStops;

          // Record timeout history
          const timeoutList = Array.isArray(cleanedStops.timeoutDriverIds)
            ? [...cleanedStops.timeoutDriverIds]
            : [];
          if (!timeoutList.includes(targetDriverId)) {
            timeoutList.push(targetDriverId);
          }
          cleanedStops.timeoutDriverIds = timeoutList;
          cleanedStops.lastTimedOutDriverId = targetDriverId;
          cleanedStops.lastTimedOutAt = new Date().toISOString();

          // Conditional update
          const updateResult = await tx.ride.updateMany({
            where: {
              id: ride.id,
              status: TripStatus.SEARCHING,
              driverId: targetDriverId,
            },
            data: {
              driverId: null,
              vehicleId: null,
              status: TripStatus.SEARCHING,
              stops: cleanedStops,
            },
          });

          return updateResult.count > 0;
        });

        if (releaseSucceeded) {
          // Send notification to the timed-out driver so their app dismisses the offer
          try {
            const dp = await prisma.driverProfile.findUnique({
              where: { id: targetDriverId },
              select: { userId: true },
            });
            if (dp?.userId) {
              await notificationsService.sendToUser({
                userId: dp.userId,
                title: '⏱️ Assignment Offer Expired',
                message: `Assignment offer for ride ${bookingDisplay} has expired and returned to dispatch pool.`,
                type: 'assignment_expired',
                data: {
                  rideId: ride.id,
                  bookingCode: bookingDisplay,
                },
              });
            }
          } catch (notifErr) {
            console.error(`[SchedulerService] Failed to send offer expired notification to driver ${targetDriverId}:`, notifErr);
          }

          // Automatic Next-Driver Dispatch attempt
          let autoRedispatched = false;
          try {
            const candidates = await driverAvailabilityService.getCandidateDriversForRide(ride.id);
            const latestRide = await prisma.ride.findUnique({
              where: { id: ride.id },
              include: {
                customer: { select: { id: true, name: true, phone: true } },
                fareBreakdown: true,
              },
            });

            if (latestRide && latestRide.status === TripStatus.SEARCHING && latestRide.driverId === null) {
              const latestMeta = (latestRide.stops && typeof latestRide.stops === 'object') ? (latestRide.stops as any) : {};
              const currentTimeoutIds: string[] = Array.isArray(latestMeta.timeoutDriverIds) ? latestMeta.timeoutDriverIds : [];
              const rejectedIds: string[] = Array.isArray(latestMeta.rejectedDriverIds) ? latestMeta.rejectedDriverIds : [];

              // Find next eligible candidate who hasn't already timed out or rejected this ride, and is not the target driver being released
              const nextCandidate = candidates.availableDrivers.find(
                (c) => c.driverId && c.driverId !== targetDriverId && !currentTimeoutIds.includes(c.driverId) && !rejectedIds.includes(c.driverId)
              );

              if (nextCandidate && nextCandidate.driverId) {
                const nextDriverId = nextCandidate.driverId;
                const nextVehicleId = nextCandidate.vehicle?.id || nextCandidate.driver?.assignedVehicleId || null;

                const assignedNow = new Date();
                const assignedExpires = new Date(assignedNow.getTime() + 120000);

                const assignedStops: any = {
                  ...latestMeta,
                  assignmentId: randomUUID(),
                  assignedAt: assignedNow.toISOString(),
                  assignmentExpiresAt: assignedExpires.toISOString(),
                };
                delete assignedStops.acceptedAt;
                delete assignedStops.driverIdleAlertSentAt;
                delete assignedStops.isDriverIdle;
                delete assignedStops.driverIdleMinutes;
                delete assignedStops.idleAlertState;
                delete assignedStops.idleAlertDispatchedAt;
                delete assignedStops.idleAlertAttempts;
                delete assignedStops.idleAlertLastAttemptAt;
                delete assignedStops.idleAlertLastError;

                // Atomic conditional assignment serialized with booking advisory lock
                const redispatchSucceeded = await prisma.$transaction(async (tx) => {
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;

                  const checkRide = await tx.ride.findUnique({
                    where: { id: ride.id },
                    select: { status: true, driverId: true },
                  });
                  if (!checkRide || checkRide.status !== TripStatus.SEARCHING || checkRide.driverId !== null) {
                    return false;
                  }

                  const recheckDriver = await driverAvailabilityService.evaluateDriverAvailability(
                    nextDriverId,
                    candidates.targetRide,
                    new Date(),
                    tx
                  );
                  if (!recheckDriver.isAvailable) {
                    return false;
                  }

                  const updateRes = await tx.ride.updateMany({
                    where: {
                      id: ride.id,
                      status: TripStatus.SEARCHING,
                      driverId: null,
                    },
                    data: {
                      driverId: nextDriverId,
                      vehicleId: nextVehicleId,
                      status: TripStatus.SEARCHING,
                      stops: assignedStops,
                    },
                  });

                  return updateRes.count > 0;
                });

                if (redispatchSucceeded) {
                  autoRedispatched = true;
                  console.log(`[SchedulerService] Auto-redispatched ride ${bookingDisplay} to next eligible driver ${nextDriverId}.`);

                  // Broadcast socket status for new assignment
                  socketService.broadcastRideStatus(ride.id, TripStatus.SEARCHING, {
                    assignedDriverId: nextDriverId,
                    assignedVehicleId: nextVehicleId,
                    assignedAt: assignedNow.toISOString(),
                  });

                  // Send push notification to newly assigned driver
                  try {
                    const nextDp = await prisma.driverProfile.findUnique({
                      where: { id: nextDriverId },
                      select: { userId: true },
                    });
                    if (nextDp?.userId) {
                      const smartCode = latestRide.bookingCode || `GC-${latestRide.id.replace(/-/g, '').substring(0, 6).toUpperCase()}`;
                      const pickupOtp = latestRide.startOtp || '';

                      await notificationsService.sendToUser({
                        userId: nextDp.userId,
                        title: '🚖 New Trip Assigned!',
                        message: `You have been assigned ride ${smartCode}. Open app to accept.`,
                        type: 'ride_assigned',
                        data: {
                          rideId: latestRide.id,
                          bookingCode: smartCode,
                          pickupLocation: latestRide.pickupLocation,
                          pickupAddress: latestRide.pickupAddress || latestRide.pickupLocation,
                          dropLocation: latestRide.dropLocation,
                          dropAddress: latestRide.dropAddress || latestRide.dropLocation,
                          distance: `${latestRide.distanceKm} km`,
                          estimatedFare: `₹${Math.round(latestRide.fareBreakdown?.totalFare ?? latestRide.estimatedFare ?? 0)}`,
                          tripType: standardizeTripType({
                            customTripType: (latestRide.stops as any)?.customTripType,
                            tripType: latestRide.tripType,
                            distanceKm: latestRide.distanceKm,
                          }),
                          isElite: String(!!(
                            (latestRide.stops as any)?.isElite ||
                            (latestRide.stops as any)?.category === 'ELITE' ||
                            (latestRide.stops as any)?.requestedVehicle?.toLowerCase().includes('elite') ||
                            latestRide.tripType?.toLowerCase().includes('elite')
                          )),
                          paymentMethod: latestRide.paymentMethod,
                          customerName: latestRide.customer?.name || 'Customer',
                          customerPhone: latestRide.customer?.phone || '',
                          riderName: (latestRide.stops as any)?.riderName || '',
                          riderPhone: (latestRide.stops as any)?.riderPhone || '',
                          passengerName: ((latestRide.stops as any)?.riderName && (latestRide.stops as any)?.riderName !== 'For me')
                            ? (latestRide.stops as any)?.riderName
                            : (latestRide.customer?.name || 'Customer'),
                          passengerPhone: (latestRide.stops as any)?.riderPhone || latestRide.customer?.phone || '',
                          startOtp: pickupOtp,
                          pickupLat: String(latestRide.pickupLat ?? 11.9360),
                          pickupLng: String(latestRide.pickupLng ?? 79.8174),
                          dropLat: String(latestRide.dropLat ?? 11.9680),
                          dropLng: String(latestRide.dropLng ?? 79.8105),
                        },
                      });
                    }
                  } catch (pushErr) {
                    console.error(`[SchedulerService] Failed to send push notification to redispatched driver ${nextDriverId}:`, pushErr);
                  }
                }
              }
            }
          } catch (redispatchErr) {
            console.error(`[SchedulerService] Error evaluating candidates for redispatch on ride ${bookingDisplay}:`, redispatchErr);
          }

          if (!autoRedispatched) {
            // No next candidate available: broadcast unassigned status to live fleet & tracking
            socketService.broadcastRideStatus(ride.id, TripStatus.SEARCHING, {
              unassigned: true,
              previousDriverId: targetDriverId,
              reason: 'Assignment offer expired (120s timeout)',
            });
          }
        }
      }
    } catch (err) {
      console.error('[SchedulerService] Error running checkAndExpireDriverAssignments:', err);
    } finally {
      this.isCheckingExpiredAssignments = false;
    }
  }

  /**
   * Layer 4: Detects drivers who accepted a ride but have remained idle / waiting for >5 minutes
   * without transitioning to EN_ROUTE (navigating to pickup).
   * Sends high-priority warning to driver app and real-time alert to admin dashboard.
   */
  /**
   * Layer 4: Detects drivers who accepted a ride but have remained idle / waiting for >5 minutes
   * without transitioning to EN_ROUTE (navigating to pickup).
   * Scheduled rides: max(acceptedAt, scheduledAt) + 300 seconds.
   * Immediate rides: acceptedAt + 300 seconds.
   * Sends high-priority warning to driver app and real-time alert to admin dashboard.
   */
  async checkDriverIdleDelays() {
    if (this.isCheckingDriverIdleDelays) return;
    this.isCheckingDriverIdleDelays = true;

    try {
      const now = new Date();
      const IDLE_LIMIT_MS = 5 * 60 * 1000; // 300 seconds

      // Find candidate rides: ACCEPTED status with an assigned driver
      const candidateRides = await prisma.ride.findMany({
        where: {
          status: TripStatus.ACCEPTED,
          driverId: { not: null },
        },
        select: {
          id: true,
          bookingCode: true,
          driverId: true,
          customerId: true,
          stops: true,
          createdAt: true,
          updatedAt: true,
          driver: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
            },
          },
          customer: { select: { id: true, name: true, phone: true } },
        },
      });

      for (const ride of candidateRides) {
        if (!ride.driverId) continue;

        const meta = (ride.stops && typeof ride.stops === 'object') ? (ride.stops as any) : {};
        const displayCode = ride.bookingCode || ride.id.slice(-6);

        // Do not process if alert was already dispatched for this assignment
        if (meta.idleAlertState === 'DISPATCHED' || meta.driverIdleAlertSentAt) {
          continue;
        }

        // Active lease check: If currently processing by another scheduler instance within lease window (120s), skip
        if (meta.idleAlertState === 'PROCESSING') {
          const lastAttempt = meta.idleAlertLastAttemptAt ? new Date(meta.idleAlertLastAttemptAt).getTime() : 0;
          if (now.getTime() - lastAttempt < 120000) {
            continue; // Leased to an active execution
          }
        }

        const acceptedAtTime = meta.acceptedAt
          ? new Date(meta.acceptedAt).getTime()
          : (ride.updatedAt ? new Date(ride.updatedAt).getTime() : new Date(ride.createdAt).getTime());

        const isScheduled = !!meta.isScheduled || (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);

        let alertThresholdTime: number;

        if (isScheduled) {
          // Scheduled ride validation: must have valid scheduledAt
          if (!meta.scheduledAt || typeof meta.scheduledAt !== 'string' || meta.scheduledAt.trim().length === 0) {
            console.warn(`[SchedulerService] ⚠️ Scheduled ride #${displayCode} (${ride.id}) missing scheduledAt date. Skipping safely.`);
            continue;
          }

          const scheduledTime = new Date(meta.scheduledAt).getTime();
          if (isNaN(scheduledTime)) {
            console.warn(`[SchedulerService] ⚠️ Scheduled ride #${displayCode} (${ride.id}) has invalid scheduledAt date string "${meta.scheduledAt}". Skipping safely.`);
            continue;
          }

          // Exact formula: max(acceptedAt, scheduledAt) + 300 seconds
          const effectiveBaseTime = Math.max(acceptedAtTime, scheduledTime);
          alertThresholdTime = effectiveBaseTime + IDLE_LIMIT_MS;
        } else {
          // Immediate ride threshold: acceptedAt + 300 seconds
          alertThresholdTime = acceptedAtTime + IDLE_LIMIT_MS;
        }

        if (now.getTime() < alertThresholdTime) {
          continue; // 5-minute threshold has not elapsed
        }

        const idleMinutes = Math.max(1, Math.floor((now.getTime() - alertThresholdTime + IDLE_LIMIT_MS) / 60000));
        const assignmentId = meta.assignmentId || ride.driverId;
        const driverName = ride.driver?.user?.name || 'Driver';
        const driverUserId = ride.driver?.user?.id;

        // Atomic multi-instance claim inside database transaction
        const claimSucceeded = await prisma.$transaction(async (tx) => {
          const fresh = await tx.ride.findUnique({
            where: { id: ride.id },
            select: { status: true, driverId: true, stops: true },
          });
          if (!fresh || fresh.status !== TripStatus.ACCEPTED || fresh.driverId !== ride.driverId) {
            return false;
          }
          const freshMeta = (fresh.stops && typeof fresh.stops === 'object') ? (fresh.stops as any) : {};
          if (freshMeta.idleAlertState === 'DISPATCHED' || freshMeta.driverIdleAlertSentAt) {
            return false;
          }
          if (freshMeta.idleAlertState === 'PROCESSING') {
            const attemptTime = freshMeta.idleAlertLastAttemptAt ? new Date(freshMeta.idleAlertLastAttemptAt).getTime() : 0;
            if (now.getTime() - attemptTime < 120000) {
              return false;
            }
          }

          await tx.ride.update({
            where: { id: ride.id },
            data: {
              stops: {
                ...freshMeta,
                isDriverIdle: true,
                driverIdleMinutes: idleMinutes,
                idleAlertState: 'PROCESSING',
                idleAlertAttempts: (freshMeta.idleAlertAttempts || 0) + 1,
                idleAlertLastAttemptAt: now.toISOString(),
              },
            },
          });
          return true;
        });

        if (!claimSucceeded) {
          continue; // Claimed or completed by concurrent scheduler instance
        }

        console.log(`[SchedulerService] ⚠️ Driver idle alert dispatching for ride #${displayCode}: Driver ${driverName} idle for ${idleMinutes}m (Assignment: ${assignmentId}).`);

        let dispatchSucceeded = false;
        let dispatchError: string | null = null;

        try {
          // 1. Alert Driver via Push Notification (Outside DB transaction)
          if (driverUserId) {
            await notificationsService.sendToUser({
              userId: driverUserId,
              title: '⚠️ Action Required: Start Your Trip',
              message: `You accepted Booking #${displayCode} ${idleMinutes} minutes ago. Please tap "Navigate to Pickup" to proceed, or Admin may reassign/cancel this ride.`,
              type: 'driver_idle_warning',
              data: {
                rideId: ride.id,
                bookingCode: ride.bookingCode || '',
                action: 'START_NAVIGATION',
                assignmentId,
                driverId: ride.driverId,
              },
            });
          }

          // 2. Alert Admins via Push Notification
          await notificationsService.sendToAdmins({
            title: '⚠️ Driver Idle Alert (5+ Mins)',
            message: `Driver ${driverName} accepted Booking #${displayCode} ${idleMinutes} mins ago but has not started navigating to pickup.`,
            type: 'driver_idle_alert',
            data: {
              rideId: ride.id,
              bookingCode: ride.bookingCode || '',
              driverId: ride.driverId,
              driverName,
              idleMinutes: String(idleMinutes),
              assignmentId,
            },
          });

          // 3. Real-time broadcast to ride room (driver & customer) and admin fleet room
          socketService.broadcastDriverIdleAlert(ride.id, {
            rideId: ride.id,
            bookingCode: ride.bookingCode || '',
            driverId: ride.driverId,
            driverName,
            idleMinutes,
            isDriverIdle: true,
            assignmentId,
            message: `Driver has been idle for ${idleMinutes} minutes without navigating.`,
          });

          dispatchSucceeded = true;
        } catch (dispatchErr: any) {
          dispatchError = dispatchErr?.message || String(dispatchErr);
          console.error(`[SchedulerService] Notification delivery error for ride #${displayCode}:`, dispatchErr);
        }

        // Commit dispatch state based on delivery attempt outcome
        const postRide = await prisma.ride.findUnique({
          where: { id: ride.id },
          select: { stops: true },
        });
        const postMeta = (postRide?.stops && typeof postRide.stops === 'object') ? (postRide.stops as any) : {};

        await prisma.ride.update({
          where: { id: ride.id },
          data: {
            stops: {
              ...postMeta,
              isDriverIdle: true,
              driverIdleMinutes: idleMinutes,
              idleAlertState: dispatchSucceeded ? 'DISPATCHED' : 'FAILED',
              ...(dispatchSucceeded
                ? {
                    idleAlertDispatchedAt: now.toISOString(),
                    driverIdleAlertSentAt: now.toISOString(),
                  }
                : {}),
              idleAlertLastError: dispatchError,
            },
          },
        });
      }
    } catch (err) {
      console.error('[SchedulerService] Error checking driver idle delays:', err);
    } finally {
      this.isCheckingDriverIdleDelays = false;
    }
  }

  /**
   * Monitors immediate unassigned rides sitting in SEARCHING status (driverId = null)
   * for >= 5 minutes (300 seconds) and emits an Admin attention alert.
   * Rules:
   * - Excludes scheduled rides.
   * - Never cancels the ride, never releases capacity, never auto-assigns.
   * - Uses atomic lease/retry state in stops JSONB so repeated runs never duplicate alerts
   *   and failed notification deliveries are retried safely.
   */
  async checkUnassignedSearchingDelays(options?: { targetRideId?: string }) {
    if (this.isCheckingUnassignedSearching) return;
    this.isCheckingUnassignedSearching = true;

    try {
      const now = new Date();
      const UNASSIGNED_LIMIT_MS = 5 * 60 * 1000; // 300 seconds
      const thresholdDate = new Date(now.getTime() - UNASSIGNED_LIMIT_MS);

      const candidateRides = await prisma.ride.findMany({
        where: {
          ...(options?.targetRideId ? { id: options.targetRideId } : {}),
          status: TripStatus.SEARCHING,
          driverId: null,
          createdAt: { lte: thresholdDate },
        },
        select: {
          id: true,
          bookingCode: true,
          customerId: true,
          pickupLocation: true,
          dropLocation: true,
          stops: true,
          createdAt: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      });

      for (const ride of candidateRides) {
        const meta = (ride.stops && typeof ride.stops === 'object') ? (ride.stops as any) : {};
        const displayCode = ride.bookingCode || ride.id.slice(-6);

        const isScheduled =
          !!meta.isScheduled ||
          (typeof meta.scheduledAt === 'string' && meta.scheduledAt.trim().length > 0);
        if (isScheduled) {
          continue; // Scheduled rides are excluded
        }

        if (meta.unassignedAlertState === 'DISPATCHED' || meta.unassignedAlertSentAt) {
          continue;
        }

        if (meta.unassignedAlertState === 'PROCESSING') {
          const lastAttempt = meta.unassignedAlertLastAttemptAt
            ? new Date(meta.unassignedAlertLastAttemptAt).getTime()
            : 0;
          if (now.getTime() - lastAttempt < 120000) {
            continue; // Active lease held by another worker
          }
        }

        const createdAtMs = new Date(ride.createdAt).getTime();
        if (now.getTime() - createdAtMs < UNASSIGNED_LIMIT_MS) {
          continue;
        }

        const waitingMinutes = Math.max(5, Math.floor((now.getTime() - createdAtMs) / 60000));
        const seatCap = Number(meta.seatCapacity) || (
          String(meta.requestedSeats || meta.requestedVehicle || '').includes('6') ? 6 : 4
        );
        const categoryLabel = seatCap >= 6 ? '6-Seater' : '4-Seater';

        // Atomic multi-instance lease claim
        const claimSucceeded = await prisma.$transaction(async (tx) => {
          const fresh = await tx.ride.findUnique({
            where: { id: ride.id },
            select: { status: true, driverId: true, stops: true },
          });
          if (!fresh || fresh.status !== TripStatus.SEARCHING || fresh.driverId !== null) {
            return false;
          }
          const freshMeta = (fresh.stops && typeof fresh.stops === 'object') ? (fresh.stops as any) : {};
          const freshIsScheduled =
            !!freshMeta.isScheduled ||
            (typeof freshMeta.scheduledAt === 'string' && freshMeta.scheduledAt.trim().length > 0);
          if (freshIsScheduled) {
            return false;
          }
          if (freshMeta.unassignedAlertState === 'DISPATCHED' || freshMeta.unassignedAlertSentAt) {
            return false;
          }
          if (freshMeta.unassignedAlertState === 'PROCESSING') {
            const attemptTime = freshMeta.unassignedAlertLastAttemptAt
              ? new Date(freshMeta.unassignedAlertLastAttemptAt).getTime()
              : 0;
            if (now.getTime() - attemptTime < 120000) {
              return false;
            }
          }

          await tx.ride.update({
            where: { id: ride.id },
            data: {
              stops: {
                ...freshMeta,
                unassignedAlertState: 'PROCESSING',
                unassignedAlertAttempts: (freshMeta.unassignedAlertAttempts || 0) + 1,
                unassignedAlertLastAttemptAt: now.toISOString(),
              },
            },
          });
          return true;
        });

        if (!claimSucceeded) {
          continue;
        }

        console.log(
          `[SchedulerService] ⏳ Unassigned SEARCHING alert dispatching for ride #${displayCode} (${categoryLabel}, waiting ${waitingMinutes}m).`
        );

        let dispatchSucceeded = false;
        let dispatchError: string | null = null;

        try {
          const notifResult = await notificationsService.sendToAdmins({
            title: '⏳ Unassigned Ride Waiting (5+ Mins)',
            message: `Booking #${displayCode} (${categoryLabel}) has been waiting in SEARCHING for ${waitingMinutes} mins without an assigned driver. Action required (assign or cancel).`,
            type: 'unassigned_ride_alert',
            data: {
              rideId: ride.id,
              bookingCode: ride.bookingCode || '',
              category: categoryLabel,
              waitingMinutes: String(waitingMinutes),
              status: 'SEARCHING',
            },
          });

          if (notifResult && notifResult.success === false) {
            throw new Error(notifResult.message || 'Admin notification dispatch returned success=false');
          }

          socketService.getIO()?.to('admin_live_fleet').emit('unassigned_ride_alert', {
            rideId: ride.id,
            bookingCode: ride.bookingCode || '',
            category: categoryLabel,
            seatCapacity: seatCap,
            waitingMinutes,
            pickupLocation: ride.pickupLocation,
            dropLocation: ride.dropLocation,
            customerName: ride.customer?.name || 'Customer',
            status: 'SEARCHING',
            message: `Unassigned ride #${displayCode} waiting for ${waitingMinutes} minutes.`,
          });

          dispatchSucceeded = true;
        } catch (dispatchErr: any) {
          dispatchError = dispatchErr?.message || String(dispatchErr);
          console.error(
            `[SchedulerService] Unassigned ride alert delivery error for #${displayCode}:`,
            dispatchErr
          );
        }

        const postRide = await prisma.ride.findUnique({
          where: { id: ride.id },
          select: { stops: true },
        });
        const postMeta = (postRide?.stops && typeof postRide.stops === 'object') ? (postRide.stops as any) : {};

        await prisma.ride.update({
          where: { id: ride.id },
          data: {
            stops: {
              ...postMeta,
              unassignedAlertState: dispatchSucceeded ? 'DISPATCHED' : 'FAILED',
              ...(dispatchSucceeded
                ? {
                    unassignedAlertDispatchedAt: now.toISOString(),
                    unassignedAlertSentAt: now.toISOString(),
                  }
                : {}),
              unassignedAlertLastError: dispatchError,
            },
          },
        });
      }
    } catch (err) {
      console.error('[SchedulerService] Error checking unassigned SEARCHING delays:', err);
    } finally {
      this.isCheckingUnassignedSearching = false;
    }
  }

  /**
   * Manual trigger (for Admin API or testing)
   */
  async triggerManualReset(options?: { force?: boolean }) {
    this.isProcessing = true;
    try {
      const { istDate } = this.getCurrentIST();
      const result = await vehiclesService.resetDailyDriveOnlyAllocations(options);
      this.lastRunDate = istDate;
      this.lastRunAt = new Date().toISOString();
      this.lastResetCount = result.resetCount;
      this.lastSkippedCount = result.skippedCount;
      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  getStatus(): SchedulerStatus {
    const { istDate } = this.getCurrentIST();
    // Compute next midnight IST ISO estimation
    const now = new Date();
    const nextMidnight = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    return {
      isRunning: this.timer !== null,
      lastRunAt: this.lastRunAt,
      lastRunDate: this.lastRunDate,
      lastResetCount: this.lastResetCount,
      lastSkippedCount: this.lastSkippedCount,
      nextScheduledMidnightIST: `Next 00:00 IST after ${istDate}`,
    };
  }
}

export const schedulerService = new SchedulerService();
