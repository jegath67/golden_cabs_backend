import { strict as assert } from 'assert';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { prisma } from '../src/config/prisma';
import { driverAvailabilityService } from '../src/modules/rides/driver-availability.service';
import { ridesService } from '../src/modules/rides/rides.service';
import { driversService } from '../src/modules/drivers/drivers.service';
import { schedulerService } from '../src/modules/scheduler/scheduler.service';
import { adminController } from '../src/modules/admin/admin.controller';

async function main() {
  const stamp = Date.now().toString();
  console.log('======================================================');
  console.log(`[TEST] Starting Strict 4/6-Seater Isolation & Concurrency Suite (stamp: ${stamp})`);
  console.log('======================================================');

  const createdUserIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdRideIds: string[] = [];

  const callAdminAssign = async (rideId: string, driverId: string, vehicleId?: string) => {
    let statusCode = 200;
    let body: any = null;
    const reply: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send(payload: any) {
        body = payload;
        return this;
      },
    };
    await adminController.assignRide(
      { params: { id: rideId }, body: { driverId, ...(vehicleId ? { vehicleId } : {}) }, log: { error: () => {} } } as any,
      reply
    );
    return { statusCode, body };
  };

  const createTestCustomer = async (suffix: string) => {
    const u = await prisma.user.create({
      data: {
        phone: `96${suffix}${stamp.slice(-5)}`.slice(0, 10),
        name: `Conc Cust ${suffix}`,
        email: `conc_c_${suffix}_${stamp}@test.local`,
        role: 'CUSTOMER',
      },
    });
    createdUserIds.push(u.id);
    return u;
  };

  const createTestDriver = async (suffix: string, seatCapacity: 4 | 6, isOnline = true) => {
    const u = await prisma.user.create({
      data: {
        phone: `95${suffix}${stamp.slice(-5)}`.slice(0, 10),
        name: `Conc Drv ${seatCapacity}S ${suffix}`,
        role: 'DRIVER',
      },
    });
    createdUserIds.push(u.id);

    const v = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-CC-${seatCapacity}-${suffix}-${stamp.slice(-3)}`,
        brand: seatCapacity === 6 ? 'Toyota' : 'Maruti',
        model: seatCapacity === 6 ? 'Innova' : 'Dzire',
        year: 2024,
        category: seatCapacity === 6 ? 'PREMIUM' : 'BUDGET',
        seatCapacity,
        status: 'VERIFIED',
      },
    });
    createdVehicleIds.push(v.id);

    const d = await prisma.driverProfile.create({
      data: {
        userId: u.id,
        personaType: 'OWN_VEHICLE',
        approvalStatus: 'APPROVED',
        isOnline,
        shiftStatus: isOnline ? 'ON_SHIFT' : 'OFF_SHIFT',
        currentLatitude: 11.9416,
        currentLongitude: 79.8083,
        assignedVehicleId: v.id,
      },
    });
    createdDriverIds.push(d.id);
    return { user: u, vehicle: v, driver: d };
  };

  const bookImmediate = async (customerId: string, seatCapacity: 4 | 6, extra: any = {}) => {
    const ride = await ridesService.requestRide(customerId, {
      pickupLocation: 'White Town, Puducherry',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville, Puducherry',
      dropLat: 11.98,
      dropLng: 79.81,
      requestedSeats: seatCapacity === 6 ? '6 Seater Cab' : '4 Seater Cab',
      seatCapacity,
      ...extra,
    });
    createdRideIds.push(ride.id);
    return ride;
  };

  try {
    const cust1 = await createTestCustomer('11');
    const cust2 = await createTestCustomer('22');

    // Normalize any pre-existing baseline fleet (surplus OR deficit) so 1-driver tests are deterministic
    const baseline = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    for (let i = 0; i < baseline.fourSeater.count; i++) {
      await bookImmediate(cust1.id, 4, { skipAvailabilityCheck: true });
    }
    for (let i = 0; i < baseline.sixSeater.count; i++) {
      await bookImmediate(cust1.id, 6, { skipAvailabilityCheck: true });
    }

    // If pre-existing unassigned SEARCHING rides in dev DB exceed pre-existing online drivers,
    // add temporary padding drivers (cleaned up in finally) so net capacity sits cleanly at 0 (not negative).
    for (let pad = 0; pad < 10; pad++) {
      const probeDrv = await createTestDriver(`p4${pad}`, 4, true);
      const probeAvail = await driverAvailabilityService.checkCategoryAvailability({
        pickupLat: 11.9416,
        pickupLng: 79.8083,
      });
      if (probeAvail.fourSeater.count >= 1) {
        // Remove the last probe driver so net4 is exactly 0
        await prisma.driverProfile.delete({ where: { id: probeDrv.driver.id } });
        createdDriverIds.pop();
        await prisma.vehicle.delete({ where: { id: probeDrv.vehicle.id } });
        createdVehicleIds.pop();
        await prisma.user.delete({ where: { id: probeDrv.user.id } });
        createdUserIds.pop();
        break;
      }
    }

    const zeroState = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(zeroState.fourSeater.count, 0, 'Normalized 4-seater baseline must be 0');
    assert.equal(zeroState.sixSeater.count, 0, 'Normalized 6-seater baseline must be 0');

    // =========================================================================
    // Test 1 & 3 & 4: 1 6-Seater driver:
    // - 4-Seater request returns unavailable (409)
    // - Explicit switch to 6-Seater succeeds
    // - Two simultaneous 6-Seater requests: 1 succeeds, 1 gets 409
    // =========================================================================
    console.log('\n--- Scenario 1, 3, 4: 1 6-Seater driver + 4-Seater unavailable + simultaneous 6-Seater requests ---');
    const d6_1 = await createTestDriver('61', 6, true);

    // Rule 1 & 3: 4-Seater must be unavailable when only 6-Seater is online
    const avail6Only = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(avail6Only.fourSeater.available, false, '4-Seater must be unavailable when only 6-Seater exists');
    assert.equal(avail6Only.sixSeater.available, true, '6-Seater must be available');

    let err4On6 = false;
    try {
      const unexpectedRide = await bookImmediate(cust1.id, 4);
      console.error('[DEBUG] bookImmediate(4) unexpectedly succeeded:', unexpectedRide.id);
    } catch (e: any) {
      if (e.statusCode === 409 && e.code === 'CATEGORY_UNAVAILABLE') {
        err4On6 = true;
      } else {
        console.error('[DEBUG] bookImmediate(4) threw unexpected error:', e);
      }
    }
    assert.equal(err4On6, true, '4-Seater request must return 409 when only 6-Seater driver exists');

    // Simultaneous 6-Seater requests (also exercises separate connection / Promise.all concurrency)
    const sim6Results = await Promise.allSettled([
      bookImmediate(cust1.id, 6),
      bookImmediate(cust2.id, 6),
    ]);
    const sim6Success = sim6Results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const sim6Rejected = sim6Results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    assert.equal(sim6Success.length, 1, 'Exactly 1 simultaneous 6-Seater request must succeed');
    assert.equal(sim6Rejected.length, 1, 'Second simultaneous 6-Seater request must be rejected');
    assert.equal((sim6Rejected[0].reason as any).statusCode, 409);
    assert.equal((sim6Rejected[0].reason as any).code, 'CATEGORY_UNAVAILABLE');

    const ride6_1 = sim6Success[0].value;
    assert.equal(ride6_1.status, 'SEARCHING');
    assert.equal(ride6_1.driverId, null);

    const afterSim6 = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterSim6.sixSeater.count, 0, 'Pending SEARCHING ride6_1 reserves the sole 6-Seater slot');
    console.log('✓ Scenarios 1, 3, 4 Passed: Strict 4/6 isolation & atomic 6-Seater concurrency verified.');

    // =========================================================================
    // Test 5: Driver declines -> reservation kept
    // =========================================================================
    console.log('\n--- Scenario 5: Driver decline keeps reservation ---');
    const assignRes = await callAdminAssign(ride6_1.id, d6_1.driver.id);
    assert.equal(assignRes.statusCode, 200);

    await ridesService.declineRide(d6_1.user.id, ride6_1.id, 'Too far');
    const afterDecline = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterDecline.sixSeater.available, false, 'Declined SEARCHING ride must keep capacity reserved');
    console.log('✓ Scenario 5 Passed: Driver decline keeps reservation.');

    // =========================================================================
    // Test 6: 120-second assignment timeout -> reservation kept
    // =========================================================================
    console.log('\n--- Scenario 6: 120s timeout keeps reservation ---');
    const r6Meta = (await prisma.ride.findUnique({ where: { id: ride6_1.id } }))!.stops as any;
    await prisma.ride.update({
      where: { id: ride6_1.id },
      data: {
        driverId: d6_1.driver.id,
        vehicleId: d6_1.vehicle.id,
        status: 'SEARCHING',
        stops: {
          ...r6Meta,
          rejectedDriverIds: [],
          assignmentExpiresAt: new Date(Date.now() - 5000).toISOString(),
        },
      },
    });
    await schedulerService.checkAndExpireDriverAssignments();
    const afterTimeoutRide = await prisma.ride.findUnique({ where: { id: ride6_1.id } });
    assert.equal(afterTimeoutRide?.status, 'SEARCHING');
    assert.equal(afterTimeoutRide?.driverId, null);

    const afterTimeoutAvail = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterTimeoutAvail.sixSeater.available, false, 'Timed-out SEARCHING ride must keep capacity reserved');
    console.log('✓ Scenario 6 Passed: 120s assignment timeout keeps reservation.');

    // =========================================================================
    // Test 7: > 5 minutes in SEARCHING -> no auto-cancel, reservation kept
    // =========================================================================
    console.log('\n--- Scenario 7: >5 minutes in SEARCHING does not auto-cancel and keeps reservation ---');
    await prisma.ride.update({
      where: { id: ride6_1.id },
      data: { createdAt: new Date(Date.now() - 8 * 60 * 1000) },
    });
    await schedulerService.checkDriverIdleDelays();
    await schedulerService.checkAndExpireDriverAssignments();

    const after5MinRide = await prisma.ride.findUnique({ where: { id: ride6_1.id } });
    assert.equal(after5MinRide?.status, 'SEARCHING', 'Ride >5 mins in SEARCHING must NOT auto-cancel');
    const after5MinAvail = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(after5MinAvail.sixSeater.available, false, 'Ride >5 mins in SEARCHING must keep capacity reserved');
    console.log('✓ Scenario 7 Passed: >5 minutes in SEARCHING keeps reservation without auto-cancel.');

    // =========================================================================
    // Test 8: Admin cancellation releases reservation
    // =========================================================================
    console.log('\n--- Scenario 8: Admin cancellation releases reservation ---');
    await ridesService.updateStatus(ride6_1.id, 'CANCELLED', 'ADMIN', 'Operational cancel');
    const afterAdminCancel = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterAdminCancel.sixSeater.available, true, 'Admin cancel must release 6-Seater reservation');
    assert.equal(afterAdminCancel.sixSeater.count, 1);
    console.log('✓ Scenario 8 Passed: Admin cancellation releases reservation.');

    // =========================================================================
    // Test 9: Customer cancellation releases reservation
    // =========================================================================
    console.log('\n--- Scenario 9: Customer cancellation releases reservation ---');
    const ride6_2 = await bookImmediate(cust1.id, 6);
    assert.equal(
      (await driverAvailabilityService.checkCategoryAvailability({ pickupLat: 11.9416, pickupLng: 79.8083 })).sixSeater.count,
      0
    );
    await ridesService.updateStatus(ride6_2.id, 'CANCELLED', 'CUSTOMER', 'Changed plans', cust1.id);
    const afterCustCancel = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterCustCancel.sixSeater.count, 1, 'Customer cancel must release 6-Seater reservation');
    console.log('✓ Scenario 9 Passed: Customer cancellation releases reservation.');

    // =========================================================================
    // Test 2 & 10: 1 4-Seater driver:
    // - Two simultaneous 4-Seater requests
    // - Admin manual assignment cannot mismatch category (cannot assign 6-Seater to 4-Seater or 4-Seater to 6-Seater)
    // =========================================================================
    console.log('\n--- Scenario 2 & 10: Simultaneous 4-Seater requests & Admin category mismatch block ---');
    const d4_1 = await createTestDriver('41', 4, true);

    const sim4Results = await Promise.allSettled([
      bookImmediate(cust1.id, 4),
      bookImmediate(cust2.id, 4),
    ]);
    const sim4Success = sim4Results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const sim4Rejected = sim4Results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    assert.equal(sim4Success.length, 1, 'Exactly 1 simultaneous 4-Seater request must succeed');
    assert.equal(sim4Rejected.length, 1, 'Second simultaneous 4-Seater request must fail with 409');
    assert.equal((sim4Rejected[0].reason as any).statusCode, 409);

    const ride4_1 = sim4Success[0].value;

    // Rule 5: Admin attempts to assign 6-Seater driver (d6_1) to 4-Seater ride (ride4_1) -> must be rejected (409)
    const mismatchAssign = await callAdminAssign(ride4_1.id, d6_1.driver.id);
    assert.equal(mismatchAssign.statusCode, 409, 'Admin manual assignment must reject 6-Seater for 4-Seater ride');
    assert.equal(mismatchAssign.body.reasonCode, 'CATEGORY_MISMATCH');

    // Also test explicit mismatched vehicleId override on Admin assign
    const mismatchVehAssign = await callAdminAssign(ride4_1.id, d4_1.driver.id, d6_1.vehicle.id);
    assert.notEqual(mismatchVehAssign.statusCode, 200, 'Admin cannot override with mismatched 6-Seater vehicleId');
    console.log('✓ Scenarios 2 & 10 Passed: Simultaneous 4-Seater requests & Admin category enforcement verified.');

    // =========================================================================
    // Test 11: Scheduled bookings do not consume immediate capacity
    // =========================================================================
    console.log('\n--- Scenario 11: Scheduled bookings do not consume immediate capacity ---');
    const futureIso = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const schedRide = await bookImmediate(cust1.id, 6, { scheduledAt: futureIso });
    assert.equal(schedRide.status, 'SEARCHING');

    const afterSchedAvail = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(afterSchedAvail.sixSeater.count, 1, 'Scheduled 6-Seater ride must NOT consume immediate 6-Seater capacity');
    console.log('✓ Scenario 11 Passed: Scheduled rides do not consume immediate capacity.');

    // =========================================================================
    // Test 12 & 15: Assigned SEARCHING rides are NOT double-counted
    // =========================================================================
    console.log('\n--- Scenario 15: Assigned SEARCHING rides are not double-counted ---');
    const d6_2 = await createTestDriver('62', 6, true);
    // Now we have 2 online 6-Seater drivers (d6_1, d6_2).
    const ride6_a = await bookImmediate(cust1.id, 6);
    // Assign d6_1 (still SEARCHING, driverId = d6_1)
    const assignA = await callAdminAssign(ride6_a.id, d6_1.driver.id);
    assert.equal(assignA.statusCode, 200);

    // 2 total drivers - 1 assigned SEARCHING ride = 1 remaining available (NOT 0!)
    const availAfterAssign = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(
      availAfterAssign.sixSeater.count,
      1,
      'Assigned SEARCHING ride (driverId != null) must NOT be double-counted'
    );
    const ride6_b = await bookImmediate(cust2.id, 6);
    assert.equal(ride6_b.status, 'SEARCHING');
    console.log('✓ Scenario 15 Passed: Assigned SEARCHING rides are not double-counted.');

    // =========================================================================
    // Test 13 & 14: Driver OFF_SHIFT race & Admin assign race
    // =========================================================================
    console.log('\n--- Scenarios 13 & 14: Driver OFF_SHIFT race & Admin assign race ---');
    // Release ride6_b so d6_2 is free
    await ridesService.updateStatus(ride6_b.id, 'CANCELLED', 'ADMIN', 'Reset for race test');

    const [shiftRes, raceBookRes] = await Promise.allSettled([
      driversService.toggleShift(d6_2.user.id, 'OFF_SHIFT'),
      bookImmediate(cust2.id, 6),
    ]);
    assert.equal(shiftRes.status, 'fulfilled', 'Driver OFF_SHIFT must complete cleanly under lock');
    if (raceBookRes.status === 'fulfilled') {
      // If booking won the lock first, verify it saw d6_2 online before OFF_SHIFT
      assert.equal(raceBookRes.value.status, 'SEARCHING');
      await ridesService.updateStatus(raceBookRes.value.id, 'CANCELLED', 'ADMIN', 'Cleanup race ride');
    } else {
      assert.equal((raceBookRes.reason as any).statusCode, 409);
    }

    // Admin assign race on existing unassigned ride vs new booking when 1 driver is online
    await driversService.toggleShift(d6_2.user.id, 'ON_SHIFT');
    const rPending = await bookImmediate(cust1.id, 6);
    const [admRace, bookRace] = await Promise.allSettled([
      callAdminAssign(rPending.id, d6_2.driver.id),
      bookImmediate(cust2.id, 6),
    ]);
    assert.equal(admRace.status, 'fulfilled');
    assert.equal((admRace.value as any).statusCode, 200);
    assert.equal(bookRace.status, 'rejected', 'Second booking must fail with 409 while rPending reserves d6_2');
    assert.equal((bookRace.reason as any).statusCode, 409);
    console.log('✓ Scenarios 13 & 14 Passed: Driver OFF_SHIFT and Admin assign races handled cleanly.');

    // =========================================================================
    // Test 12: Multi-instance / separate DB connection concurrency
    // =========================================================================
    console.log('\n--- Scenario 12: Multi-instance / separate DB connection concurrency ---');
    // Cancel rPending so d6_2 is free (1 available 6-seater slot)
    await ridesService.updateStatus(rPending.id, 'CANCELLED', 'ADMIN', 'Reset for multi-conn test');

    const connStr = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
    const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: connStr }) });
    try {
      let conn2CommittedAt = 0;
      let conn1FinishedAt = 0;
      let resolveLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((res) => {
        resolveLockAcquired = res;
      });

      // Connection 2 acquires the same advisory lock, signals, holds it for 200ms, and inserts a 6-seater SEARCHING ride
      const conn2Tx = prisma2.$transaction(async (tx2) => {
        await tx2.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;
        resolveLockAcquired();
        await new Promise((res) => setTimeout(res, 200));
        const r = await tx2.ride.create({
          data: {
            bookingCode: `GC-MC-${stamp.slice(-6)}`,
            customerId: cust1.id,
            tripType: 'ONE_WAY',
            status: 'SEARCHING',
            pickupLocation: 'White Town',
            pickupLat: 11.9416,
            pickupLng: 79.8083,
            dropLocation: 'Auroville',
            dropLat: 11.98,
            dropLng: 79.81,
            distanceKm: 10,
            estimatedFare: 500,
            startOtp: '1234',
            paymentMethod: 'CASH',
            stops: { isScheduled: false, seatCapacity: 6, requestedVehicle: '6 Seater Cab' },
          },
        });
        createdRideIds.push(r.id);
        conn2CommittedAt = Date.now();
        return r;
      });

      // Wait until separate DB connection 2 actually holds the advisory lock, then contend from connection 1
      await lockAcquired;
      const conn1Attempt = bookImmediate(cust2.id, 6).finally(() => {
        conn1FinishedAt = Date.now();
      });

      const [r2Res, r1Res] = await Promise.allSettled([conn2Tx, conn1Attempt]);
      assert.equal(r2Res.status, 'fulfilled', 'Separate connection tx2 must succeed');
      assert.equal(r1Res.status, 'rejected', 'Contending connection tx1 must wait and receive 409');
      assert.equal((r1Res.reason as any).statusCode, 409);
      assert.ok(
        conn1FinishedAt >= conn2CommittedAt,
        `tx1 (${conn1FinishedAt}) must block until tx2 commits (${conn2CommittedAt})`
      );
      console.log('✓ Scenario 12 Passed: Separate DB connection blocked on advisory lock and saw committed ride.');
    } finally {
      await prisma2.$disconnect();
    }

    console.log('\n======================================================');
    console.log('ALL 15 CONCURRENCY & ISOLATION SCENARIOS PASSED! ✓');
    console.log('======================================================');
  } finally {
    console.log('\n[TEST] Cleaning up test records...');
    for (const rId of createdRideIds) {
      await prisma.fareBreakdown.deleteMany({ where: { rideId: rId } });
      await prisma.ride.deleteMany({ where: { id: rId } });
    }
    for (const dId of createdDriverIds) {
      await prisma.driverProfile.deleteMany({ where: { id: dId } });
    }
    for (const vId of createdVehicleIds) {
      await prisma.vehicle.deleteMany({ where: { id: vId } });
    }
    for (const uId of createdUserIds) {
      await prisma.user.deleteMany({ where: { id: uId } });
    }
    await prisma.$disconnect();
    console.log('[TEST] Cleanup completed.');
  }
}

main().catch((err) => {
  console.error('[TEST] Failed with error:', err);
  process.exit(1);
});
