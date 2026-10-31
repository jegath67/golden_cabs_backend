import { prisma } from '../../config/prisma';

export interface UnavailabilityRecord {
  id: string;
  driverId: string | null;
  vehicleId: string | null;
  date: string; // 'YYYY-MM-DD'
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class UnavailabilityService {
  /**
   * Normalize any Date or String to YYYY-MM-DD
   */
  normalizeDate(input: string | Date): string {
    if (input instanceof Date) {
      const year = input.getFullYear();
      const month = String(input.getMonth() + 1).padStart(2, '0');
      const day = String(input.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    const clean = input.trim().substring(0, 10);
    return clean;
  }

  /**
   * Save (replace or upsert) a driver or vehicle's unavailability schedule
   */
  async saveSchedule(
    driverId?: string | null,
    vehicleId?: string | null,
    dates: (string | Date)[] = [],
    reason = 'Scheduled Offline'
  ): Promise<{ success: boolean; count: number; dates: string[] }> {
    const normalizedDates = Array.from(new Set(dates.map((d) => this.normalizeDate(d))));

    // Also look up assigned vehicle or driver to ensure two-way sync
    let effectiveVehicleId = vehicleId || null;
    let effectiveDriverId = driverId || null;

    if (driverId && !effectiveVehicleId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { assignedVehicleId: true },
      });
      if (driver?.assignedVehicleId) {
        effectiveVehicleId = driver.assignedVehicleId;
      }
    } else if (vehicleId && !effectiveDriverId) {
      const driver = await prisma.driverProfile.findFirst({
        where: { assignedVehicleId: vehicleId },
        select: { id: true },
      });
      if (driver?.id) {
        effectiveDriverId = driver.id;
      }
    }

    // Clear existing schedules for this driver / vehicle
    if (effectiveDriverId && effectiveVehicleId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE "driverId" = $1 OR "vehicleId" = $2`,
        effectiveDriverId,
        effectiveVehicleId
      );
    } else if (effectiveDriverId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE "driverId" = $1`,
        effectiveDriverId
      );
    } else if (effectiveVehicleId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE "vehicleId" = $1`,
        effectiveVehicleId
      );
    }

    // Insert new dates
    for (const dateStr of normalizedDates) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "UnavailabilitySchedule" ("driverId", "vehicleId", "date", "reason", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        effectiveDriverId,
        effectiveVehicleId,
        dateStr,
        reason
      );
    }

    return {
      success: true,
      count: normalizedDates.length,
      dates: normalizedDates,
    };
  }

  /**
   * Fetch all unavailable dates for a driver or vehicle
   */
  async getSchedule(
    driverId?: string | null,
    vehicleId?: string | null
  ): Promise<string[]> {
    let effectiveVehicleId = vehicleId || null;
    let effectiveDriverId = driverId || null;

    if (driverId && !effectiveVehicleId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { assignedVehicleId: true },
      });
      if (driver?.assignedVehicleId) {
        effectiveVehicleId = driver.assignedVehicleId;
      }
    }

    let rows: any[] = [];
    if (effectiveDriverId && effectiveVehicleId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT "date" FROM "UnavailabilitySchedule" WHERE "driverId" = $1 OR "vehicleId" = $2 ORDER BY "date" ASC`,
        effectiveDriverId,
        effectiveVehicleId
      );
    } else if (effectiveDriverId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT "date" FROM "UnavailabilitySchedule" WHERE "driverId" = $1 ORDER BY "date" ASC`,
        effectiveDriverId
      );
    } else if (effectiveVehicleId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT "date" FROM "UnavailabilitySchedule" WHERE "vehicleId" = $1 ORDER BY "date" ASC`,
        effectiveVehicleId
      );
    }

    return rows.map((r: any) => r.date);
  }

  /**
   * Remove a specific date from schedule
   */
  async removeDate(
    driverId?: string | null,
    vehicleId?: string | null,
    date: string | Date = ''
  ): Promise<boolean> {
    const dateStr = this.normalizeDate(date);
    let effectiveVehicleId = vehicleId || null;
    let effectiveDriverId = driverId || null;

    if (driverId && !effectiveVehicleId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { assignedVehicleId: true },
      });
      if (driver?.assignedVehicleId) {
        effectiveVehicleId = driver.assignedVehicleId;
      }
    }

    if (effectiveDriverId && effectiveVehicleId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE ("driverId" = $1 OR "vehicleId" = $2) AND "date" = $3`,
        effectiveDriverId,
        effectiveVehicleId,
        dateStr
      );
    } else if (effectiveDriverId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE "driverId" = $1 AND "date" = $2`,
        effectiveDriverId,
        dateStr
      );
    } else if (effectiveVehicleId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "UnavailabilitySchedule" WHERE "vehicleId" = $1 AND "date" = $2`,
        effectiveVehicleId,
        dateStr
      );
    }

    return true;
  }

  /**
   * Check whether a driver or vehicle is scheduled unavailable on a given date (YYYY-MM-DD or Date)
   */
  async isUnavailable(
    driverId?: string | null,
    vehicleId?: string | null,
    targetDate: string | Date = new Date()
  ): Promise<boolean> {
    const dateStr = this.normalizeDate(targetDate);
    let effectiveVehicleId = vehicleId || null;
    let effectiveDriverId = driverId || null;

    if (driverId && !effectiveVehicleId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { id: driverId },
        select: { assignedVehicleId: true },
      });
      if (driver?.assignedVehicleId) {
        effectiveVehicleId = driver.assignedVehicleId;
      }
    }

    let rows: any[] = [];
    if (effectiveDriverId && effectiveVehicleId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "UnavailabilitySchedule" WHERE ("driverId" = $1 OR "vehicleId" = $2) AND "date" = $3 LIMIT 1`,
        effectiveDriverId,
        effectiveVehicleId,
        dateStr
      );
    } else if (effectiveDriverId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "UnavailabilitySchedule" WHERE "driverId" = $1 AND "date" = $2 LIMIT 1`,
        effectiveDriverId,
        dateStr
      );
    } else if (effectiveVehicleId) {
      rows = await prisma.$queryRawUnsafe(
        `SELECT "id" FROM "UnavailabilitySchedule" WHERE "vehicleId" = $1 AND "date" = $2 LIMIT 1`,
        effectiveVehicleId,
        dateStr
      );
    }

    return rows.length > 0;
  }
}

export const unavailabilityService = new UnavailabilityService();
