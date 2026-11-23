import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { ridesService } from '../src/modules/rides/rides.service';
import { schedulerService } from '../src/modules/scheduler/scheduler.service';
import { adminController } from '../src/modules/admin/admin.controller';
import { TripStatus } from '../src/generated/prisma/client';

async function runTests() {
  const stamp = Date.now().toString();
  console.log(`[TEST] Starting 120s Assignment Expiry & Automatic Redispatch Regression Suite (stamp: ${stamp})`);

  const createdRideIds: string[] = [];
  let testCustomerId = '';
  let testDriverUserIdA = '';
  let testDriverProfileIdA = '';
  let testVehicleIdA = '';
  let testDriverUserIdB = '';
  let testDriverProfileIdB = '';
  let testVehicleIdB = '';

  try {
    // 0. Setup test users and driver profiles
    const cust = await prisma.user.create({
      data: {
        phone: `9111${stamp.slice(-6)}`,
        name: `Cust Expiry ${stamp}`,
        email: `cust_exp_${stamp}@test.local`,
        role: 'CUSTOMER',
      },
    });
    testCustomerId = cust.id;

    const vehicleA = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-EXP-A-${stamp.slice(-3)}`,
        brand: 'Toyota',
        model: 'Etios',
        year: 2022,
        status: 'VERIFIED',
      },
    });
    testVehicleIdA = vehicleA.id;

    const drvUserA = await prisma.user.create({
      data: {
        phone: `9222${stamp.slice(-6)}`,
        name: `Driver A ${stamp}`,
        role: 'DRIVER',
        isActive: true,
      },
    });
    testDriverUserIdA = drvUserA.id;

    const drvProfileA = await prisma.driverProfile.create({
      data: {
        userId: drvUserA.id,
        approvalStatus: 'APPROVED',
        assignedVehicleId: vehicleA.id,
        personaType: 'OWN_VEHICLE',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        currentLatitude: 11.935,
        currentLongitude: 79.835,
      },
    });
    testDriverProfileIdA = drvProfileA.id;

    const vehicleB = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-EXP-B-${stamp.slice(-3)}`,
        brand: 'Maruti',
        model: 'Dzire',
        year: 2023,
        status: 'VERIFIED',
      },
    });
    testVehicleIdB = vehicleB.id;

    const drvUserB = await prisma.user.create({
      data: {
        phone: `9333${stamp.slice(-6)}`,
        name: `Driver B ${stamp}`,
        role: 'DRIVER',
        isActive: true,
      },
    });
    testDriverUserIdB = drvUserB.id;

    const drvProfileB = await prisma.driverProfile.create({
      data: {
        userId: drvUserB.id,
        approvalStatus: 'APPROVED',
        assignedVehicleId: vehicleB.id,
        personaType: 'OWN_VEHICLE',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        currentLatitude: 11.936,
        currentLongitude: 79.836,
      },
    });
    testDriverProfileIdB = drvProfileB.id;

    console.log(`[TEST] Test fixtures created: Customer=${testCustomerId}, DriverA=${testDriverProfileIdA}, DriverB=${testDriverProfileIdB}`);

    // Helper to build ride base data
    const baseRideData = {
      customerId: testCustomerId,
      pickupLocation: 'White Town, Pondy',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Auroville',
      dropLat: 12.00,
      dropLng: 79.81,
      distanceKm: 10,
      estimatedFare: 300,
      startOtp: '1234',
    };

    // =========================================================================
    // Test 1: Acceptance within 120s succeeds
    // =========================================================================
    console.log('\n--- Test 1: Acceptance within 120s succeeds ---');
    const ride1 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-1-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 30 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() + 90 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride1.id);

    const acceptedRide1 = await ridesService.acceptRide(testDriverUserIdA, ride1.id);
    assert.equal(acceptedRide1.status, TripStatus.ACCEPTED, 'Ride status must become ACCEPTED');
    assert.equal(acceptedRide1.driverId, testDriverProfileIdA, 'Driver ID must remain driver A');
    // Complete ride1 so Driver A is free for subsequent tests
    await prisma.ride.update({ where: { id: ride1.id }, data: { status: TripStatus.COMPLETED } });
    console.log('✓ Test 1 Passed: Offer within 120s successfully accepted.');

    // =========================================================================
    // Test 1B: Exact Boundary - Acceptance at 119 seconds succeeds
    // =========================================================================
    console.log('\n--- Test 1B: Acceptance at 119s boundary succeeds ---');
    const realDateNow1B = Date.now;
    const fixedNow1B = realDateNow1B();
    try {
      Date.now = () => fixedNow1B;
      const ride1B = await prisma.ride.create({
        data: {
          ...baseRideData,
          bookingCode: `GC-TEST-1B-${stamp.slice(-5)}`,
          driverId: testDriverProfileIdA,
          vehicleId: testVehicleIdA,
          status: TripStatus.SEARCHING,
          stops: {
            assignedAt: new Date(fixedNow1B - 119 * 1000).toISOString(),
            assignmentExpiresAt: new Date(fixedNow1B + 1 * 1000).toISOString(),
          },
        },
      });
      createdRideIds.push(ride1B.id);

      const acceptedRide1B = await ridesService.acceptRide(testDriverUserIdA, ride1B.id);
      assert.equal(acceptedRide1B.status, TripStatus.ACCEPTED, 'Ride status must become ACCEPTED at 119s');
      assert.equal(acceptedRide1B.driverId, testDriverProfileIdA, 'Driver ID must remain driver A');
      await prisma.ride.update({ where: { id: ride1B.id }, data: { status: TripStatus.COMPLETED } });
      console.log('✓ Test 1B Passed: Offer at 119s boundary successfully accepted.');
    } finally {
      Date.now = realDateNow1B;
    }

    // =========================================================================
    // Test 1C: Exact Boundary - Acceptance at exactly 120 seconds (120,000ms) succeeds per <= 120s rule
    // =========================================================================
    console.log('\n--- Test 1C: Acceptance at exactly 120s (120,000ms) succeeds per rule ---');
    const realDateNow1C = Date.now;
    const fixedNow1C = realDateNow1C();
    try {
      Date.now = () => fixedNow1C;
      const ride1C = await prisma.ride.create({
        data: {
          ...baseRideData,
          bookingCode: `GC-TEST-1C-${stamp.slice(-5)}`,
          driverId: testDriverProfileIdA,
          vehicleId: testVehicleIdA,
          status: TripStatus.SEARCHING,
          stops: {
            assignedAt: new Date(fixedNow1C - 120000).toISOString(),
            assignmentExpiresAt: new Date(fixedNow1C).toISOString(),
          },
        },
      });
      createdRideIds.push(ride1C.id);

      const acceptedRide1C = await ridesService.acceptRide(testDriverUserIdA, ride1C.id);
      assert.equal(acceptedRide1C.status, TripStatus.ACCEPTED, 'Ride status must become ACCEPTED at exactly 120s');
      assert.equal(acceptedRide1C.driverId, testDriverProfileIdA, 'Driver ID must remain driver A');
      await prisma.ride.update({ where: { id: ride1C.id }, data: { status: TripStatus.COMPLETED } });
      console.log('✓ Test 1C Passed: Offer at exactly 120s boundary successfully accepted.');
    } finally {
      Date.now = realDateNow1C;
    }

    // =========================================================================
    // Test 2: Acceptance after 120s (> 120,000ms) throws offer expired error
    // =========================================================================
    console.log('\n--- Test 2: Acceptance after 120s throws offer expired error ---');
    const realDateNow2 = Date.now;
    const fixedNow2 = realDateNow2();
    try {
      Date.now = () => fixedNow2;
      const ride2 = await prisma.ride.create({
        data: {
          ...baseRideData,
          bookingCode: `GC-TEST-2-${stamp.slice(-5)}`,
          driverId: testDriverProfileIdA,
          vehicleId: testVehicleIdA,
          status: TripStatus.SEARCHING,
          stops: {
            assignedAt: new Date(fixedNow2 - 120001).toISOString(),
            assignmentExpiresAt: new Date(fixedNow2 - 1).toISOString(),
          },
        },
      });
      createdRideIds.push(ride2.id);

      let acceptExpiredError: any = null;
      try {
        await ridesService.acceptRide(testDriverUserIdA, ride2.id);
      } catch (err: any) {
        acceptExpiredError = err;
      }
      assert.ok(acceptExpiredError, 'acceptRide must throw when accepting after 120s');
      assert.match(
        acceptExpiredError.message,
        /Assignment expired/i,
        'Error message must indicate assignment expired'
      );
      // Cancel ride2 so it does not linger in SEARCHING pool
      await prisma.ride.update({ where: { id: ride2.id }, data: { status: TripStatus.CANCELLED } });
      console.log(`✓ Test 2 Passed: Acceptance rejected with: "${acceptExpiredError.message}"`);
    } finally {
      Date.now = realDateNow2;
    }

    // =========================================================================
    // Test 3: Concurrency protection: accepted ride is never unassigned by scheduler
    // =========================================================================
    console.log('\n--- Test 3: Accepted ride is never unassigned by scheduler ---');
    const ride3 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-3-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.ACCEPTED,
        stops: {
          assignedAt: new Date(Date.now() - 200 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 80 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride3.id);

    await schedulerService.checkAndExpireDriverAssignments();

    const refreshedRide3 = await prisma.ride.findUnique({ where: { id: ride3.id } });
    assert.ok(refreshedRide3, 'Ride 3 must exist');
    assert.equal(refreshedRide3.status, TripStatus.ACCEPTED, 'Status must remain ACCEPTED');
    assert.equal(refreshedRide3.driverId, testDriverProfileIdA, 'Driver must NOT be cleared');
    assert.equal(refreshedRide3.vehicleId, testVehicleIdA, 'Vehicle must NOT be cleared');
    // Complete ride3 so Driver A is free
    await prisma.ride.update({ where: { id: ride3.id }, data: { status: TripStatus.COMPLETED } });
    console.log('✓ Test 3 Passed: Accepted ride is never unassigned by scheduler.');

    // =========================================================================
    // Test 4: Automatic Redispatch to next candidate when offer expires
    // =========================================================================
    console.log('\n--- Test 4: Automatic Redispatch on offer expiry ---');
    const ride4 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-4-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 130 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 10 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride4.id);

    // Run scheduler check
    await schedulerService.checkAndExpireDriverAssignments();

    const redispatchedRide4 = await prisma.ride.findUnique({ where: { id: ride4.id } });
    assert.ok(redispatchedRide4, 'Ride 4 must exist');
    assert.equal(redispatchedRide4.status, TripStatus.SEARCHING, 'Status must remain SEARCHING');
    assert.notEqual(redispatchedRide4.driverId, testDriverProfileIdA, 'Timed-out driver A must NOT be reassigned');
    assert.ok(redispatchedRide4.driverId, 'Ride must be redispatched to another candidate driver');

    const meta4 = (redispatchedRide4.stops as any) || {};
    assert.ok(meta4.assignmentExpiresAt, 'New assignment must have fresh assignmentExpiresAt');
    assert.ok(Array.isArray(meta4.timeoutDriverIds), 'timeoutDriverIds must exist');
    assert.ok(meta4.timeoutDriverIds.includes(testDriverProfileIdA), 'Driver A must be recorded in timeoutDriverIds');
    console.log(`✓ Test 4 Passed: Expired driver A released, auto-redispatched to driver: ${redispatchedRide4.driverId}`);
    // Complete ride4 so Driver B is free
    await prisma.ride.update({ where: { id: ride4.id }, data: { status: TripStatus.COMPLETED } });

    // =========================================================================
    // Test 4B: Multi-Worker Concurrency: Two concurrent scheduler executions expiring the same ride
    // =========================================================================
    console.log('\n--- Test 4B: Multi-Worker Concurrency on simultaneous assignment expiry ---');
    const ride4B = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-4B-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 130 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 10 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride4B.id);

    // Simulate two concurrent worker executions attempting to expire the same ride simultaneously
    await Promise.all([
      schedulerService.checkAndExpireDriverAssignments(),
      schedulerService.checkAndExpireDriverAssignments(),
    ]);

    const refreshedRide4B = await prisma.ride.findUnique({ where: { id: ride4B.id } });
    assert.ok(refreshedRide4B, 'Ride 4B must exist');
    assert.equal(refreshedRide4B.status, TripStatus.SEARCHING, 'Ride status must remain SEARCHING');
    assert.notEqual(refreshedRide4B.driverId, testDriverProfileIdA, 'Driver A must be unassigned');

    // Exactly one driver assignment must be persisted (either redispatched or null)
    const meta4B = (refreshedRide4B.stops as any) || {};
    const timeoutIds4B: string[] = Array.isArray(meta4B.timeoutDriverIds) ? meta4B.timeoutDriverIds : [];
    const occurrencesA = timeoutIds4B.filter((id) => id === testDriverProfileIdA).length;
    assert.equal(occurrencesA, 1, 'Driver A must appear in timeout history exactly once (no double-processing)');
    console.log(`✓ Test 4B Passed: Multi-worker concurrency handled cleanly. Single persistent driver: ${refreshedRide4B.driverId}`);
    // Free any assigned driver on ride4B
    await prisma.ride.update({ where: { id: ride4B.id }, data: { status: TripStatus.COMPLETED } });

    // =========================================================================
    // Test 4C: Accept-vs-Timeout Race Condition Safety
    // =========================================================================
    console.log('\n--- Test 4C: Accept-vs-Timeout race condition safety ---');
    const ride4C = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-4C-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 120050).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 50).toISOString(),
        },
      },
    });
    createdRideIds.push(ride4C.id);

    // Fire acceptance and scheduler expiry simultaneously
    const [acceptRes, schedulerRes] = await Promise.allSettled([
      ridesService.acceptRide(testDriverUserIdA, ride4C.id),
      schedulerService.checkAndExpireDriverAssignments(),
    ]);

    const refreshedRide4C = await prisma.ride.findUnique({ where: { id: ride4C.id } });
    assert.ok(refreshedRide4C, 'Ride 4C must exist');
    // In all cases, the ride must either be cleanly ACCEPTED by Driver A or SEARCHING without Driver A
    if (refreshedRide4C.status === TripStatus.ACCEPTED) {
      assert.equal(refreshedRide4C.driverId, testDriverProfileIdA, 'Accepted ride retains Driver A');
      console.log('✓ Test 4C Passed: Accept won race -> Ride safely ACCEPTED, scheduler did not corrupt it.');
    } else {
      assert.equal(refreshedRide4C.status, TripStatus.SEARCHING);
      assert.notEqual(refreshedRide4C.driverId, testDriverProfileIdA, 'Timeout won race -> Driver A safely released');
      assert.equal(acceptRes.status, 'rejected', 'Late acceptance was rejected cleanly');
      console.log('✓ Test 4C Passed: Timeout won race -> Driver A cleanly released, acceptance rejected safely.');
    }
    await prisma.ride.update({ where: { id: ride4C.id }, data: { status: TripStatus.COMPLETED } });

    // =========================================================================
    // Test 4D: Reject-vs-Timeout Race Condition Safety
    // =========================================================================
    console.log('\n--- Test 4D: Reject-vs-Timeout race condition safety ---');
    const ride4D = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-4D-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 121000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride4D.id);

    // Fire driver decline and scheduler expiry concurrently
    await Promise.allSettled([
      ridesService.declineRide(testDriverUserIdA, ride4D.id, 'Driver busy'),
      schedulerService.checkAndExpireDriverAssignments(),
    ]);

    const refreshedRide4D = await prisma.ride.findUnique({ where: { id: ride4D.id } });
    assert.ok(refreshedRide4D, 'Ride 4D must exist');
    assert.equal(refreshedRide4D.status, TripStatus.SEARCHING, 'Ride must remain in SEARCHING pool');
    assert.notEqual(refreshedRide4D.driverId, testDriverProfileIdA, 'Driver A must be unassigned');
    console.log('✓ Test 4D Passed: Reject-vs-Timeout race resolved safely without deadlock or corruption.');
    await prisma.ride.update({ where: { id: ride4D.id }, data: { status: TripStatus.COMPLETED } });

    // =========================================================================
    // Test 5: Fallback to SEARCHING with driverId=null when all candidates time out
    // =========================================================================
    console.log('\n--- Test 5: Fallback to SEARCHING when all candidates time out ---');
    // Fetch all current approved driver IDs
    const allApproved = await prisma.driverProfile.findMany({
      where: { approvalStatus: 'APPROVED' },
      select: { id: true },
    });
    const allDriverIds = allApproved.map((d) => d.id);

    const ride5 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-5-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 130 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 10 * 1000).toISOString(),
          // Pretend all other drivers have already timed out for this ride
          timeoutDriverIds: allDriverIds.filter((id) => id !== testDriverProfileIdA),
        },
      },
    });
    createdRideIds.push(ride5.id);

    await schedulerService.checkAndExpireDriverAssignments();

    const unassignedRide5 = await prisma.ride.findUnique({ where: { id: ride5.id } });
    assert.ok(unassignedRide5, 'Ride 5 must exist');
    assert.equal(unassignedRide5.status, TripStatus.SEARCHING, 'Ride must remain SEARCHING');
    assert.equal(unassignedRide5.driverId, null, 'Driver must be null when no candidates are left');
    assert.equal(unassignedRide5.vehicleId, null, 'Vehicle must be null when no candidates are left');
    console.log('✓ Test 5 Passed: Booking left in unassigned SEARCHING state when no candidate is available.');

    // =========================================================================
    // Test 6: Admin intentional manual reassignment to timed-out driver works
    // =========================================================================
    console.log('\n--- Test 6: Admin intentional manual reassignment to timed-out driver ---');
    // Admin assigns ride5 back to Driver A
    const dummyReq: any = {
      params: { id: ride5.id },
      body: { driverId: testDriverProfileIdA },
      log: { error: console.error },
    };
    let sendData: any = null;
    const dummyReply: any = {
      status: (code: number) => ({
        send: (data: any) => { sendData = { code, data }; return dummyReply; },
      }),
      send: (data: any) => { sendData = data; return dummyReply; },
    };

    await adminController.assignRide(dummyReq, dummyReply);

    const reassignedRide5 = await prisma.ride.findUnique({ where: { id: ride5.id } });
    assert.ok(reassignedRide5, 'Ride 5 must exist');
    assert.equal(reassignedRide5.driverId, testDriverProfileIdA, 'Driver A must be assigned');
    const metaReassigned = (reassignedRide5.stops as any) || {};
    assert.ok(
      !metaReassigned.timeoutDriverIds?.includes(testDriverProfileIdA),
      'Driver A must be removed from timeoutDriverIds upon intentional manual reassignment'
    );
    assert.ok(metaReassigned.assignmentExpiresAt, 'Reassigned ride must receive fresh assignmentExpiresAt');
    console.log('✓ Test 6 Passed: Admin successfully reassigned previously timed-out driver A.');

    // =========================================================================
    // Test 7: Timed-out driver is omitted from available rides
    // =========================================================================
    console.log('\n--- Test 7: Timed-out driver is omitted from available rides ---');
    const ride7A = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-7A-${stamp.slice(-5)}`,
        driverId: null,
        vehicleId: null,
        status: TripStatus.SEARCHING,
        stops: {
          timeoutDriverIds: [testDriverProfileIdA],
          lastTimedOutDriverId: testDriverProfileIdA,
        },
      },
    });
    createdRideIds.push(ride7A.id);

    const availableToDriverA = await ridesService.getAvailableRides(50, testDriverUserIdA);
    const availableAIds = availableToDriverA.map((r: any) => r.id);

    assert.ok(!availableAIds.includes(ride7A.id), 'Timed-out ride 7A must NOT appear in Driver A available list');
    console.log('✓ Test 7 Passed: Timed-out driver correctly excluded from getAvailableRides.');

    // =========================================================================
    // Test 8: Scheduled advance rides are unaffected by 120s timeout
    // =========================================================================
    console.log('\n--- Test 8: Scheduled advance rides are unaffected by 120s timeout ---');
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ride8Scheduled = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-8-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          isScheduled: true,
          scheduledAt: futureDate.toISOString(),
          assignedAt: new Date(Date.now() - 200 * 1000).toISOString(),
          // Note: even if an old expiry was present, isScheduled guard protects it
          assignmentExpiresAt: new Date(Date.now() - 80 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride8Scheduled.id);

    await schedulerService.checkAndExpireDriverAssignments();

    const refreshedRide8 = await prisma.ride.findUnique({ where: { id: ride8Scheduled.id } });
    assert.ok(refreshedRide8, 'Ride 8 must exist');
    assert.equal(refreshedRide8.driverId, testDriverProfileIdA, 'Driver assignment must NOT be released for scheduled ride');
    console.log('✓ Test 8 Passed: Scheduled advance ride is unaffected by 120s expiry.');

    console.log('\n======================================================');
    console.log('ALL 13 REGRESSION TESTS PASSED SUCCESSFULLY! ✓');
    console.log('======================================================\n');
  } catch (error) {
    console.error('❌ Test suite failed:', error);
    throw error;
  } finally {
    console.log('[TEST] Cleaning up test records...');
    if (createdRideIds.length > 0) {
      await prisma.ride.deleteMany({ where: { id: { in: createdRideIds } } });
    }
    if (testDriverProfileIdA) {
      await prisma.driverProfile.deleteMany({ where: { id: testDriverProfileIdA } });
    }
    if (testDriverProfileIdB) {
      await prisma.driverProfile.deleteMany({ where: { id: testDriverProfileIdB } });
    }
    if (testVehicleIdA) {
      await prisma.vehicle.deleteMany({ where: { id: testVehicleIdA } });
    }
    if (testVehicleIdB) {
      await prisma.vehicle.deleteMany({ where: { id: testVehicleIdB } });
    }
    const userIds = [testCustomerId, testDriverUserIdA, testDriverUserIdB].filter(Boolean);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
    console.log('[TEST] Cleanup completed.');
  }
}

runTests().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
