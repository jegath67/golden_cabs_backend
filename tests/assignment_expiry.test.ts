import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { ridesService } from '../src/modules/rides/rides.service';
import { schedulerService } from '../src/modules/scheduler/scheduler.service';
import { TripStatus } from '../src/generated/prisma/client';

async function runTests() {
  const stamp = Date.now().toString();
  console.log(`[TEST] Starting 120s Assignment Expiry & Navigation Guard Regression Suite (stamp: ${stamp})`);

  const createdRideIds: string[] = [];
  let testCustomerId = '';
  let testDriverUserIdA = '';
  let testDriverProfileIdA = '';
  let testVehicleIdA = '';
  let testDriverUserIdB = '';
  let testDriverProfileIdB = '';

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
        vehicleNumber: `TN-EXP-${stamp.slice(-4)}`,
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
      },
    });
    testDriverProfileIdA = drvProfileA.id;

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
    console.log('✓ Test 1 Passed: Offer within 120s successfully accepted.');

    // =========================================================================
    // Test 2: Offer older than 120s is released to dispatch pool by scheduler
    // =========================================================================
    console.log('\n--- Test 2: Offer older than 120s is released to dispatch pool ---');
    const ride2 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-2-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 130 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 10 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride2.id);

    // Run scheduler assignment expiry check
    await schedulerService.checkAndExpireDriverAssignments();

    const refreshedRide2 = await prisma.ride.findUnique({ where: { id: ride2.id } });
    assert.ok(refreshedRide2, 'Ride 2 must exist');
    assert.equal(refreshedRide2.status, TripStatus.SEARCHING, 'Booking must remain SEARCHING');
    assert.equal(refreshedRide2.driverId, null, 'Driver assignment must be cleared to null');
    assert.equal(refreshedRide2.vehicleId, null, 'Vehicle assignment must be cleared to null');

    const meta2 = (refreshedRide2.stops as any) || {};
    assert.equal(meta2.assignmentExpiresAt, undefined, 'assignmentExpiresAt must be removed');
    assert.ok(Array.isArray(meta2.timeoutDriverIds), 'timeoutDriverIds must be an array');
    assert.ok(meta2.timeoutDriverIds.includes(testDriverProfileIdA), 'timeoutDriverIds must include driver A');
    assert.equal(meta2.lastTimedOutDriverId, testDriverProfileIdA, 'lastTimedOutDriverId must be driver A');
    console.log('✓ Test 2 Passed: Expired assignment released to null, SEARCHING preserved, timeout history logged.');

    // =========================================================================
    // Test 3: Acceptance after 120s throws offer expired error
    // =========================================================================
    console.log('\n--- Test 3: Acceptance after 120s throws offer expired error ---');
    const ride3 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-3-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignedAt: new Date(Date.now() - 125 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 5 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride3.id);

    let acceptExpiredError: any = null;
    try {
      await ridesService.acceptRide(testDriverUserIdA, ride3.id);
    } catch (err: any) {
      acceptExpiredError = err;
    }
    assert.ok(acceptExpiredError, 'acceptRide must throw when accepting after 120s');
    assert.match(
      acceptExpiredError.message,
      /Assignment expired/i,
      'Error message must indicate assignment expired'
    );
    console.log(`✓ Test 3 Passed: Acceptance rejected with: "${acceptExpiredError.message}"`);

    // =========================================================================
    // Test 4: Concurrency test: accepted ride is NOT unassigned by scheduler
    // =========================================================================
    console.log('\n--- Test 4: Accepted ride is NOT unassigned by scheduler ---');
    const ride4 = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-4-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.ACCEPTED,
        stops: {
          assignedAt: new Date(Date.now() - 200 * 1000).toISOString(),
          assignmentExpiresAt: new Date(Date.now() - 80 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride4.id);

    await schedulerService.checkAndExpireDriverAssignments();

    const refreshedRide4 = await prisma.ride.findUnique({ where: { id: ride4.id } });
    assert.ok(refreshedRide4, 'Ride 4 must exist');
    assert.equal(refreshedRide4.status, TripStatus.ACCEPTED, 'Status must remain ACCEPTED');
    assert.equal(refreshedRide4.driverId, testDriverProfileIdA, 'Driver must NOT be cleared');
    assert.equal(refreshedRide4.vehicleId, testVehicleIdA, 'Vehicle must NOT be cleared');
    console.log('✓ Test 4 Passed: Accepted ride is never unassigned by scheduler.');

    // =========================================================================
    // Test 5: Timed-out driver is omitted from available rides
    // =========================================================================
    console.log('\n--- Test 5: Timed-out driver is omitted from available rides ---');
    // Sub-case A: Unassigned ride that previously timed out on Driver A
    const ride5A = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-5A-${stamp.slice(-5)}`,
        driverId: null,
        vehicleId: null,
        status: TripStatus.SEARCHING,
        stops: {
          timeoutDriverIds: [testDriverProfileIdA],
          lastTimedOutDriverId: testDriverProfileIdA,
        },
      },
    });
    createdRideIds.push(ride5A.id);

    // Sub-case B: Ride currently assigned to Driver A, but assignmentExpiresAt has already passed
    const ride5B = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-5B-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          assignmentExpiresAt: new Date(Date.now() - 15 * 1000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride5B.id);

    const availableToDriverA = await ridesService.getAvailableRides(50, testDriverUserIdA);
    const availableAIds = availableToDriverA.map((r: any) => r.id);

    assert.ok(!availableAIds.includes(ride5A.id), 'Timed-out ride 5A must NOT appear in Driver A available list');
    assert.ok(!availableAIds.includes(ride5B.id), 'Expired offer 5B must NOT appear in Driver A available list');
    console.log('✓ Test 5 Passed: Timed-out and expired offers correctly excluded from getAvailableRides.');

    // =========================================================================
    // Test 6: Active rides and future scheduled rides are never filtered
    // =========================================================================
    console.log('\n--- Test 6: Active rides and future scheduled rides are never filtered ---');
    // Active EN_ROUTE ride
    const ride6EnRoute = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-6A-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.EN_ROUTE,
      },
    });
    createdRideIds.push(ride6EnRoute.id);

    // Active ONGOING ride
    const ride6Ongoing = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-6B-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.ONGOING,
      },
    });
    createdRideIds.push(ride6Ongoing.id);

    // Future scheduled ride assigned to Driver A
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ride6Scheduled = await prisma.ride.create({
      data: {
        ...baseRideData,
        bookingCode: `GC-TEST-6C-${stamp.slice(-5)}`,
        driverId: testDriverProfileIdA,
        vehicleId: testVehicleIdA,
        status: TripStatus.SEARCHING,
        stops: {
          isScheduled: true,
          scheduledAt: futureDate.toISOString(),
          assignmentExpiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    });
    createdRideIds.push(ride6Scheduled.id);

    const activeList = await ridesService.getAvailableRides(50, testDriverUserIdA);
    const activeListIds = activeList.map((r: any) => r.id);

    assert.ok(activeListIds.includes(ride6EnRoute.id), 'Active EN_ROUTE ride must be present in available rides');
    assert.ok(activeListIds.includes(ride6Ongoing.id), 'Active ONGOING ride must be present in available rides');
    assert.ok(activeListIds.includes(ride6Scheduled.id), 'Future scheduled ride must be present in available rides');
    console.log('✓ Test 6 Passed: Active journeys and scheduled rides are preserved.');

    console.log('\n======================================================');
    console.log('ALL 6 REGRESSION TESTS PASSED SUCCESSFULLY! ✓');
    console.log('======================================================\n');
  } catch (error) {
    console.error('❌ Test suite failed:', error);
    throw error;
  } finally {
    // Teardown created test records cleanly
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
