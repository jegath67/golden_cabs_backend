import { strict as assert } from 'assert';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { prisma } from '../src/config/prisma';
import { ridesController } from '../src/modules/rides/rides.controller';
import { ridesService } from '../src/modules/rides/rides.service';
import { driverAvailabilityService } from '../src/modules/rides/driver-availability.service';
import { driversService } from '../src/modules/drivers/drivers.service';
import { vehiclesService } from '../src/modules/vehicles/vehicles.service';
import { schedulerService } from '../src/modules/scheduler/scheduler.service';
import { notificationsService } from '../src/modules/notifications/notifications.service';

async function main() {
  const stamp = Date.now().toString();
  console.log('======================================================');
  console.log(`[TEST] Starting Phase 3 Final Fixes Suite (stamp: ${stamp})`);
  console.log('======================================================');

  // Snapshot existing dev DB rides GC-985119 & GC-351759 to guarantee zero modification
  const devSnapshotBefore = await prisma.ride.findMany({
    where: { bookingCode: { in: ['GC-985119', 'GC-351759'] } },
    select: { id: true, bookingCode: true, status: true, updatedAt: true, stops: true },
    orderBy: { bookingCode: 'asc' },
  });

  const createdUserIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdRideIds: string[] = [];

  const createTestUser = async (role: 'CUSTOMER' | 'DRIVER' | 'ADMIN', suffix: string) => {
    const u = await prisma.user.create({
      data: {
        phone: `94${suffix}${stamp.slice(-5)}`.slice(0, 10),
        name: `P3 ${role} ${suffix}`,
        email: `p3_${role.toLowerCase()}_${suffix}_${stamp}@test.local`,
        role,
        isActive: true,
      },
    });
    createdUserIds.push(u.id);
    return u;
  };

  const createTestDriver = async (suffix: string, seatCapacity: 4 | 6, isOnline = true) => {
    const u = await createTestUser('DRIVER', suffix);
    const v = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-P3-${seatCapacity}-${suffix}-${stamp.slice(-3)}`,
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

  const callPublicRequestRide = async (userId: string, body: any) => {
    let statusCode = 200;
    let payload: any = null;
    const reply: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send(data: any) {
        payload = data;
        return this;
      },
    };
    await ridesController.requestRide({ user: { id: userId }, body } as any, reply);
    if (statusCode === 200 && payload?.data?.id) {
      createdRideIds.push(payload.data.id);
    }
    return { statusCode, payload };
  };

  const connStr = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
  const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: connStr }) });

  try {
    const cust = await createTestUser('CUSTOMER', '101');
    const adminUser = await createTestUser('ADMIN', '901');

    // Verify zero baseline for 6-seaters (pad if any pre-existing)
    const baseAvail = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    for (let i = 0; i < baseAvail.sixSeater.count; i++) {
      const r = await ridesService.requestRide(cust.id, {
        pickupLocation: 'Pad A',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Pad B',
        dropLat: 11.98,
        dropLng: 79.81,
        seatCapacity: 6,
        skipAvailabilityCheck: true,
      });
      createdRideIds.push(r.id);
    }

    // =========================================================================
    // Tests 1, 2, 3: Public endpoint rejects skipAvailabilityCheck bypass,
    // enforces normal immediate check, and preserves scheduled booking
    // =========================================================================
    console.log('\n--- Tests 1, 2, 3: Public controller allowlist & skipAvailabilityCheck protection ---');

    // Test 1: 0 eligible 6-seaters -> sending skipAvailabilityCheck: true via HTTP controller MUST return 409
    const bypassAttempt = await callPublicRequestRide(cust.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville',
      dropLat: 11.98,
      dropLng: 79.81,
      seatCapacity: 6,
      requestedSeats: '6 Seater Cab',
      skipAvailabilityCheck: true,
    });
    assert.equal(bypassAttempt.statusCode, 409, 'Public controller must reject 6-seater even with skipAvailabilityCheck: true');
    assert.equal(bypassAttempt.payload?.code, 'CATEGORY_UNAVAILABLE');

    // Also verify normal immediate without flag returns 409 when unavailable
    const normalUnavail = await callPublicRequestRide(cust.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville',
      dropLat: 11.98,
      dropLng: 79.81,
      seatCapacity: 6,
      requestedSeats: '6 Seater Cab',
    });
    assert.equal(normalUnavail.statusCode, 409);

    // Test 3: Scheduled booking via public controller works even with 0 online 6-seaters
    const schedRes = await callPublicRequestRide(cust.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville',
      dropLat: 11.98,
      dropLng: 79.81,
      seatCapacity: 6,
      requestedSeats: '6 Seater Cab',
      scheduledAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    assert.equal(schedRes.statusCode, 200, 'Scheduled booking via public controller must remain allowed');
    assert.equal((schedRes.payload.data.stops as any).isScheduled, true);

    // Test 2: Normal public immediate booking succeeds once eligible driver is online
    const drv6_a = await createTestDriver('610', 6, true);
    const normalAvailRes = await callPublicRequestRide(cust.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville',
      dropLat: 11.98,
      dropLng: 79.81,
      seatCapacity: 6,
      requestedSeats: '6 Seater Cab',
    });
    assert.equal(normalAvailRes.statusCode, 200, 'Normal public immediate booking succeeds when 6-seater available');
    assert.equal(normalAvailRes.payload.data.status, 'SEARCHING');
    console.log('✓ Tests 1, 2, 3 Passed: Public controller blocks skipAvailabilityCheck & enforces normal/scheduled rules.');

    // Cancel normalAvailRes ride so drv6_a is free again
    await ridesService.updateStatus(normalAvailRes.payload.data.id, 'CANCELLED', 'ADMIN', 'Cleanup step');

    // =========================================================================
    // Test 4 & 5: Auto-redispatch acquires lock (202611, 1) & prevents booking/redispatch race
    // =========================================================================
    console.log('\n--- Tests 4 & 5: Auto-redispatch shared advisory lock & booking concurrency ---');
    const drv6_b = await createTestDriver('611', 6, true);

    // Create an expired-offer ride assigned to drv6_a (drv6_a timed out; drv6_b is the sole redispatch target)
    const expRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-EXP-${stamp.slice(-5)}`,
        customerId: cust.id,
        driverId: drv6_a.driver.id,
        vehicleId: drv6_a.vehicle.id,
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
        startOtp: '1111',
        paymentMethod: 'CASH',
        stops: {
          isScheduled: false,
          seatCapacity: 6,
          requestedVehicle: '6 Seater Cab',
          assignedAt: new Date(Date.now() - 180000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 5000).toISOString(),
        },
      },
    });
    createdRideIds.push(expRide.id);

    // Test 4: Verify auto-redispatch blocks on shared advisory lock held by separate DB connection prisma2
    let resolveLock1!: () => void;
    const lockHeld1 = new Promise<void>((res) => (resolveLock1 = res));
    let lockReleasedAt = 0;
    let redispatchFinishedAt = 0;

    const holdLockTx = prisma2.$transaction(async (tx2) => {
      await tx2.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;
      resolveLock1();
      await new Promise((r) => setTimeout(r, 200));
      lockReleasedAt = Date.now();
    });

    await lockHeld1;
    const redispatchPromise = schedulerService.checkAndExpireDriverAssignments().finally(() => {
      redispatchFinishedAt = Date.now();
    });

    await Promise.all([holdLockTx, redispatchPromise]);
    assert.ok(
      redispatchFinishedAt >= lockReleasedAt,
      `Auto-redispatch (${redispatchFinishedAt}) must block until lock released (${lockReleasedAt})`
    );
    const afterRedispatch = await prisma.ride.findUnique({ where: { id: expRide.id } });
    assert.equal(afterRedispatch?.driverId, drv6_b.driver.id, 'Expired ride must redispatch to drv6_b');

    // Test 5: Concurrent 2x booking + redispatch when 2 total 6-seaters exist and expRide2 is active (net = 1)
    // Regardless of lock ordering, at most 1 new booking may succeed and total active rides must never exceed 2.
    await prisma.ride.update({ where: { id: expRide.id }, data: { status: 'CANCELLED', driverId: null } });
    const expRide2 = await prisma.ride.create({
      data: {
        bookingCode: `GC-RAC-${stamp.slice(-5)}`,
        customerId: cust.id,
        driverId: drv6_b.driver.id,
        vehicleId: drv6_b.vehicle.id,
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
        startOtp: '2222',
        paymentMethod: 'CASH',
        stops: {
          isScheduled: false,
          seatCapacity: 6,
          requestedVehicle: '6 Seater Cab',
          assignedAt: new Date(Date.now() - 180000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 5000).toISOString(),
        },
      },
    });
    createdRideIds.push(expRide2.id);

    const custRace1 = await createTestUser('CUSTOMER', '102');
    const custRace2 = await createTestUser('CUSTOMER', '103');

    const [redispRace, bookRace1, bookRace2] = await Promise.all([
      schedulerService.checkAndExpireDriverAssignments(),
      callPublicRequestRide(custRace1.id, {
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        seatCapacity: 6,
      }),
      callPublicRequestRide(custRace2.id, {
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        seatCapacity: 6,
      }),
    ]);
    void redispRace;
    const raceStatuses = [bookRace1.statusCode, bookRace2.statusCode].sort();
    assert.deepEqual(
      raceStatuses,
      [200, 409],
      `Expected exactly one 200 and one 409 during redispatch+booking race, got ${JSON.stringify(raceStatuses)}`
    );
    const postRaceAvail = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(postRaceAvail.sixSeater.count, 0, 'Remaining 6-Seater capacity after race must be 0');

    // Cleanup rides from Tests 4 & 5
    await prisma.ride.updateMany({ where: { id: { in: [expRide2.id] } }, data: { status: 'CANCELLED', driverId: null } });
    for (const br of [bookRace1, bookRace2]) {
      if (br.statusCode === 200 && br.payload?.data?.id) {
        await prisma.ride.update({ where: { id: br.payload.data.id }, data: { status: 'CANCELLED', driverId: null } });
      }
    }
    console.log('✓ Tests 4 & 5 Passed: Auto-redispatch acquires (202611, 1) and never double-consumes drivers.');

    // =========================================================================
    // Test 6: Every force-OFFLINE path uses the shared advisory lock (202611, 1)
    // =========================================================================
    console.log('\n--- Test 6: Force-OFFLINE paths acquire shared advisory lock ---');
    const verifyLockBlocking = async (label: string, fn: () => Promise<any>) => {
      let resolveHeld!: () => void;
      const held = new Promise<void>((res) => (resolveHeld = res));
      let releasedAt = 0;
      let opFinishedAt = 0;

      const blocker = prisma2.$transaction(async (tx2) => {
        await tx2.$executeRaw`SELECT pg_advisory_xact_lock(202611, 1)`;
        resolveHeld();
        await new Promise((r) => setTimeout(r, 150));
        releasedAt = Date.now();
      });

      await held;
      const op = fn().finally(() => {
        opFinishedAt = Date.now();
      });
      await Promise.all([blocker, op]);
      assert.ok(opFinishedAt >= releasedAt, `${label} must wait on shared lock (op=${opFinishedAt}, rel=${releasedAt})`);
    };

    await verifyLockBlocking('driversService.toggleShift(OFF_SHIFT)', () =>
      driversService.toggleShift(drv6_a.user.id, 'OFF_SHIFT')
    );
    await verifyLockBlocking('driversService.updateDriverStatus(INACTIVE)', () =>
      driversService.updateDriverStatus(drv6_a.driver.id, 'INACTIVE')
    );
    await verifyLockBlocking('driversService.verifyDriver(REJECTED)', () =>
      driversService.verifyDriver(drv6_a.driver.id, 'REJECTED', 'Audit test')
    );
    await verifyLockBlocking('vehiclesService.updateVehicleStatus(MAINTENANCE)', () =>
      vehiclesService.updateVehicleStatus(drv6_b.vehicle.id, 'MAINTENANCE', 'Audit test')
    );
    console.log('✓ Test 6 Passed: All audited force-OFFLINE paths serialize on advisory lock (202611, 1).');

    // =========================================================================
    // Tests 7, 8, 9, 10, 11: Unassigned SEARCHING 5-minute Admin Attention Alert
    // =========================================================================
    console.log('\n--- Tests 7–11: Unassigned SEARCHING 5-minute Admin Attention Alert ---');
    // Restore drv6_b online for reservation check in Test 10
    await prisma.vehicle.update({ where: { id: drv6_b.vehicle.id }, data: { status: 'VERIFIED' } });
    await prisma.driverProfile.update({
      where: { id: drv6_b.driver.id },
      data: { isOnline: true, shiftStatus: 'ON_SHIFT', approvalStatus: 'APPROVED' },
    });

    // Immediate unassigned SEARCHING ride created 7 minutes ago
    const oldSearchingRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-UN5-${stamp.slice(-5)}`,
        customerId: cust.id,
        driverId: null,
        tripType: 'ONE_WAY',
        status: 'SEARCHING',
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        distanceKm: 10,
        estimatedFare: 600,
        startOtp: '3333',
        paymentMethod: 'CASH',
        createdAt: new Date(Date.now() - 7 * 60 * 1000),
        stops: { isScheduled: false, seatCapacity: 6, requestedVehicle: '6 Seater Cab' },
      },
    });
    createdRideIds.push(oldSearchingRide.id);

    // Scheduled unassigned SEARCHING ride created 10 minutes ago (Test 11: must NOT trigger alert)
    const oldScheduledRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-SU5-${stamp.slice(-5)}`,
        customerId: cust.id,
        driverId: null,
        tripType: 'ONE_WAY',
        status: 'SEARCHING',
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        distanceKm: 10,
        estimatedFare: 600,
        startOtp: '4444',
        paymentMethod: 'UPI',
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
        stops: {
          isScheduled: true,
          scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          seatCapacity: 6,
          requestedVehicle: '6 Seater Cab',
        },
      },
    });
    createdRideIds.push(oldScheduledRide.id);

    // Test 9: Simulate notification delivery failure first, verify FAILED state + retryability
    const origSendToAdmins = notificationsService.sendToAdmins.bind(notificationsService);
    let failNextCall = true;
    let adminAlertCalls = 0;
    (notificationsService as any).sendToAdmins = async (args: any) => {
      adminAlertCalls++;
      if (failNextCall) {
        throw new Error('Simulated FCM / Notification outage');
      }
      return origSendToAdmins(args);
    };

    try {
      await schedulerService.checkUnassignedSearchingDelays({ targetRideId: oldSearchingRide.id });
      const afterFail = await prisma.ride.findUnique({ where: { id: oldSearchingRide.id } });
      const failMeta = afterFail?.stops as any;
      assert.equal(failMeta.unassignedAlertState, 'FAILED', 'Failed handoff must record FAILED, not DISPATCHED');
      assert.equal(failMeta.unassignedAlertSentAt, undefined, 'Must not mark sentAt on failed delivery');
      assert.equal(adminAlertCalls, 1);

      // Test 7: Retry succeeds and dispatches exactly once
      failNextCall = false;
      await schedulerService.checkUnassignedSearchingDelays({ targetRideId: oldSearchingRide.id });
      const afterSuccess = await prisma.ride.findUnique({ where: { id: oldSearchingRide.id } });
      const succMeta = afterSuccess?.stops as any;
      assert.equal(succMeta.unassignedAlertState, 'DISPATCHED');
      assert.ok(succMeta.unassignedAlertSentAt, 'unassignedAlertSentAt must be recorded after delivery');
      assert.equal(succMeta.unassignedAlertAttempts, 2);
      assert.equal(adminAlertCalls, 2);

      // Test 8: Repeated scheduler runs do NOT duplicate alerts
      await schedulerService.checkUnassignedSearchingDelays({ targetRideId: oldSearchingRide.id });
      await schedulerService.checkUnassignedSearchingDelays({ targetRideId: oldSearchingRide.id });
      assert.equal(adminAlertCalls, 2, 'Repeated runs must not re-send unassigned alert');

      // Test 10: Ride stays SEARCHING and continues reserving its 6-Seater slot
      assert.equal(afterSuccess?.status, 'SEARCHING', 'Alert must NEVER auto-cancel the ride');
      assert.equal(afterSuccess?.driverId, null, 'Alert must NEVER auto-assign driver');
      const availAfterAlert = await driverAvailabilityService.checkCategoryAvailability({
        pickupLat: 11.9416,
        pickupLng: 79.8083,
      });
      assert.equal(availAfterAlert.sixSeater.available, false, 'Alert must NOT release reserved 6-Seater capacity');

      // Test 11: Scheduled SEARCHING ride >5 mins must NOT trigger unassigned_ride_alert
      await schedulerService.checkUnassignedSearchingDelays({ targetRideId: oldScheduledRide.id });
      assert.equal(adminAlertCalls, 2, 'Scheduled ride must not trigger unassigned SEARCHING alert');
      const schedAfter = await prisma.ride.findUnique({ where: { id: oldScheduledRide.id } });
      assert.equal((schedAfter?.stops as any)?.unassignedAlertSentAt, undefined);
    } finally {
      (notificationsService as any).sendToAdmins = origSendToAdmins;
      await prisma.notification.deleteMany({
        where: { userId: adminUser.id, type: 'unassigned_ride_alert' },
      });
    }
    console.log('✓ Tests 7–11 Passed: Unassigned 5-min Admin alert, idempotency, retry, reservation, & schedule exclusion verified.');

    // =========================================================================
    // Test 12: Existing accepted-driver 5-min idle alert still works untouched
    // =========================================================================
    console.log('\n--- Test 12: Existing accepted-driver 5-min idle alert intact ---');
    const acceptedIdleRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-ACC-${stamp.slice(-5)}`,
        customerId: cust.id,
        driverId: drv6_b.driver.id,
        vehicleId: drv6_b.vehicle.id,
        tripType: 'ONE_WAY',
        status: 'ACCEPTED',
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        distanceKm: 10,
        estimatedFare: 600,
        startOtp: '5555',
        paymentMethod: 'CASH',
        stops: {
          isScheduled: false,
          seatCapacity: 6,
          assignmentId: `asgn_${stamp}`,
          acceptedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(acceptedIdleRide.id);

    await schedulerService.checkDriverIdleDelays();
    const afterIdleCheck = await prisma.ride.findUnique({ where: { id: acceptedIdleRide.id } });
    assert.equal((afterIdleCheck?.stops as any)?.isDriverIdle, true);
    assert.equal((afterIdleCheck?.stops as any)?.idleAlertState, 'DISPATCHED');
    console.log('✓ Test 12 Passed: Existing ACCEPTED-driver 5-minute idle alert continues working.');

    // Verify existing dev DB rides GC-985119 and GC-351759 were NEVER touched
    const devSnapshotAfter = await prisma.ride.findMany({
      where: { bookingCode: { in: ['GC-985119', 'GC-351759'] } },
      select: { id: true, bookingCode: true, status: true, updatedAt: true, stops: true },
      orderBy: { bookingCode: 'asc' },
    });
    assert.deepEqual(
      devSnapshotAfter,
      devSnapshotBefore,
      'Existing dev DB rides GC-985119 & GC-351759 must remain 100% unmodified!'
    );

    console.log('\n======================================================');
    console.log('ALL 12 PHASE 3 FINAL FIXES TESTS PASSED! ✓');
    console.log('======================================================');
  } finally {
    console.log('\n[TEST] Cleaning up test records...');
    await prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
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
    await prisma2.$disconnect();
    await prisma.$disconnect();
    console.log('[TEST] Cleanup completed.');
  }
}

main().catch((err) => {
  console.error('[TEST] Failed with error:', err);
  process.exit(1);
});
