import { vehiclesService } from '../vehicles/vehicles.service';
import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { TripStatus } from '../../generated/prisma/client';

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

  /**
   * Initialize the scheduler at server boot
   */
  init() {
    if (this.timer) return;

    const { istDate } = this.getCurrentIST();
    // Default lastRunDate to today so it only triggers at upcoming midnight, not on midday reboot
    this.lastRunDate = istDate;

    console.log(`[SchedulerService] Initialized. Background tasks armed for vehicle reset & scheduled trip auto-expiry.`);

    // Layer 2: Run server-startup catch-up check to clean any expired allocations from previous days
    this.runStartupCatchUpReset();

    // Check every 60 seconds
    this.timer = setInterval(() => {
      this.checkAndRunMidnightReset();
      this.checkAndExpireUnassignedScheduledRides();
    }, 60 * 1000);

    // Initial check in case server started precisely at 00:00 or pending expired rides exist
    this.checkAndRunMidnightReset();
    this.checkAndExpireUnassignedScheduledRides();
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

        const createdAtTime = ride.createdAt ? new Date(ride.createdAt).getTime() : 0;
        const isOver30MinsFromCreation = createdAtTime > 0 && (now.getTime() - createdAtTime) >= 30 * 60 * 1000;

        let isPastPickup = false;
        if (meta.scheduledAt) {
          const sDate = new Date(meta.scheduledAt);
          if (!isNaN(sDate.getTime()) && sDate.getTime() <= now.getTime()) {
            isPastPickup = true;
          }
        }

        if (!isOver30MinsFromCreation && !isPastPickup) {
          continue;
        }

        const cancelReason = isOver30MinsFromCreation
          ? 'Auto-cancelled: Driver not assigned within 30 minutes of booking request'
          : 'Auto-cancelled: Scheduled pickup time has passed without driver assignment';

        console.log(`[SchedulerService] Auto-cancelling scheduled ride ${ride.bookingCode || ride.id}. Reason: ${cancelReason}`);

        const couponCode = meta.couponCode;
        const alreadyRestored = meta.couponRestored === true;

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
