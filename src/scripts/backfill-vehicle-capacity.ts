/**
 * GOLDEN CABS – PHASE 1: IDEMPOTENT VEHICLE CAPACITY & CLASSIFICATION BACKFILL SCRIPT
 *
 * SAFETY RULES:
 * 1. Default mode is DRY RUN. No records are updated unless explicitly executed with approval.
 * 2. Unverified records remain strictly capacityVerified: false and capacityVerificationSource: 'PENDING_RC_AUDIT'.
 * 3. Never overwrites existing `seatCapacity` (preserved for backward compatibility).
 * 4. Preserves all vehicle IDs, driver assignments, photos, hubs, and relationships.
 * 5. NEVER updates or alters historical Ride, FareBreakdown, or Transaction records.
 */

import { prisma } from '../config/prisma';
import fs from 'fs';
import path from 'path';

interface VehicleMappingEntry {
  vehicleId: string;
  vehicleNumber: string;
  brand: string;
  model: string;
  currentDbVehicleType: string;
  currentDbSeatCapacity: number;
  serviceCategory: 'NORMAL' | 'ELITE';
  proposedVehicleClass: string;
  proposedPassengerCapacity: number;
  proposedDriverSeatCount: number;
  proposedTotalCapacity: number;
  capacityVerified: boolean;
  verificationStatus: string;
  evidenceRequired: string;
  isApprovedForMigration: boolean;
  notes?: string;
}

export async function runVehicleCapacityBackfill(options: { dryRun?: boolean; force?: boolean } = {}) {
  const isDryRun = options.dryRun !== false;
  console.log(`\n======================================================`);
  console.log(`[Vehicle Capacity Backfill] Mode: ${isDryRun ? 'DRY RUN (NO DB WRITES)' : 'LIVE EXECUTION'}`);
  console.log(`======================================================\n`);

  const mappingPath = fileURLToPath(new URL('./vehicle-capacity-mapping.json', import.meta.url));
  if (!fs.existsSync(mappingPath)) {
    throw new Error(`Mapping file not found at: ${mappingPath}`);
  }

  const raw = fs.readFileSync(mappingPath, 'utf8');
  const mappings: VehicleMappingEntry[] = JSON.parse(raw);

  console.log(`Loaded ${mappings.length} mapping definitions from vehicle-capacity-mapping.json.`);

  const auditSummary = {
    totalEvaluated: 0,
    approvedForMigration: 0,
    pendingRcAudit: 0,
    updated: 0,
    skipped: 0,
    errors: [] as string[],
  };

  for (const entry of mappings) {
    auditSummary.totalEvaluated++;

    // Validation 1: Mathematical integrity
    const expectedTotal = entry.proposedPassengerCapacity + entry.proposedDriverSeatCount;
    if (entry.proposedTotalCapacity !== expectedTotal) {
      const err = `[Integrity Error] Vehicle ${entry.vehicleNumber}: totalCapacity (${entry.proposedTotalCapacity}) !== passenger (${entry.proposedPassengerCapacity}) + driver (${entry.proposedDriverSeatCount})`;
      console.error(err);
      auditSummary.errors.push(err);
      continue;
    }

    // Validation 2: Ensure non-negative and realistic counts
    if (entry.proposedPassengerCapacity <= 0 || entry.proposedDriverSeatCount <= 0) {
      const err = `[Range Error] Vehicle ${entry.vehicleNumber}: Capacity values must be positive integers.`;
      console.error(err);
      auditSummary.errors.push(err);
      continue;
    }

    if (entry.isApprovedForMigration && entry.capacityVerified) {
      auditSummary.approvedForMigration++;
    } else {
      auditSummary.pendingRcAudit++;
    }

    console.log(
      `-> Vehicle: ${entry.vehicleNumber} (${entry.brand} ${entry.model}) | Service: ${entry.serviceCategory} | Proposed Class: ${entry.proposedVehicleClass} | Status: ${entry.verificationStatus} (Approved: ${entry.isApprovedForMigration})`
    );

    if (!isDryRun) {
      // Find existing vehicle to guarantee presence
      const existing = await prisma.vehicle.findUnique({
        where: { id: entry.vehicleId },
        select: { id: true, vehicleNumber: true, seatCapacity: true },
      });

      if (!existing) {
        const err = `Vehicle ${entry.vehicleId} (${entry.vehicleNumber}) not found in live database. Skipping.`;
        console.warn(err);
        auditSummary.skipped++;
        continue;
      }

      // Safe update: Only update additive classification columns.
      // If NOT explicitly verified by approved RC, passengerCapacity is kept NULL or set strictly with unverified flags.
      await prisma.vehicle.update({
        where: { id: entry.vehicleId },
        data: {
          serviceCategory: entry.serviceCategory,
          vehicleClass: entry.proposedVehicleClass,
          driverSeatCount: entry.proposedDriverSeatCount,
          // Only write passengerCapacity if explicitly approved; otherwise leave unverified
          passengerCapacity: entry.isApprovedForMigration ? entry.proposedPassengerCapacity : null,
          totalCapacity: entry.isApprovedForMigration ? entry.proposedTotalCapacity : null,
          capacityVerified: entry.isApprovedForMigration ? entry.capacityVerified : false,
          capacityVerificationSource: entry.isApprovedForMigration
            ? 'RC_MANUAL_VERIFIED'
            : 'PENDING_RC_AUDIT',
          capacityVerifiedAt: entry.isApprovedForMigration ? new Date() : null,
          // CRITICAL: seatCapacity is NOT overwritten
        },
      });

      auditSummary.updated++;
    }
  }

  console.log(`\n======================================================`);
  console.log(`[Vehicle Capacity Backfill Summary]`);
  console.log(`- Total Records Evaluated: ${auditSummary.totalEvaluated}`);
  console.log(`- Approved for Verified Capacity Migration: ${auditSummary.approvedForMigration}`);
  console.log(`- Pending RC Document Verification: ${auditSummary.pendingRcAudit}`);
  console.log(`- Records Updated: ${auditSummary.updated}`);
  console.log(`- Records Skipped: ${auditSummary.skipped}`);
  console.log(`- Validation Errors: ${auditSummary.errors.length}`);
  console.log(`======================================================\n`);

  return auditSummary;
}

import { fileURLToPath } from 'url';

// Direct execution entrypoint (defaults to dry-run)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const args = process.argv.slice(2);
  const shouldExecute = args.includes('--execute');

  if (shouldExecute) {
    console.warn(`WARNING: --execute flag detected. Running live backfill...`);
    runVehicleCapacityBackfill({ dryRun: false })
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    console.log(`Running in DEFAULT DRY RUN mode (pass --execute to apply when approved)...`);
    runVehicleCapacityBackfill({ dryRun: true })
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
