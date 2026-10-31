import { vehiclesService } from '../vehicles/vehicles.service';

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

  /**
   * Initialize the scheduler at server boot
   */
  init() {
    if (this.timer) return;

    const { istDate } = this.getCurrentIST();
    // Default lastRunDate to today so it only triggers at upcoming midnight, not on midday reboot
    this.lastRunDate = istDate;

    console.log(`[SchedulerService] Initialized. Daily vehicle reset armed for next midnight IST.`);

    // Check every 60 seconds
    this.timer = setInterval(() => {
      this.checkAndRunMidnightReset();
    }, 60 * 1000);

    // Initial check in case server started precisely at 00:00
    this.checkAndRunMidnightReset();
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
