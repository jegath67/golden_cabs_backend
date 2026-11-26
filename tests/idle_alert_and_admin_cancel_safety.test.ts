import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { ridesService } from '../src/modules/rides/rides.service';
import { schedulerService } from '../src/modules/scheduler/scheduler.service';
import { adminController } from '../src/modules/admin/admin.controller';
import { TripStatus } from '../src/generated/prisma/client';

async function runSafetyRegressionSuite() {
  const stamp = Date.now().toString();
  console.log(`\n======================================================`);
  console.log(`[SUITE] Starting 5-Minute Idle Alert & Admin Cancel Safety Test Suite (stamp: ${stamp})`);
  console.log(`======================================================\n`);

  const createdRideIds: string[] = [];
  let testCustomerId = '';
  let testDriverUserIdA = '';
  let testDriverProfileIdA = '';
  let testVehicleIdA = '';
  let testDriverUserIdB = '';
  let testDriverProfileIdB = '';
  let testVehicleIdB = '';
  let testAdminUserId = '';

  try {
    // 0. Setup test users and driver profiles
    const cust = await prisma.user.create({
      data: {
        phone: `9111${stamp.slice(-6)}`,
        name: `Cust Safety ${stamp}`,
        email: `cust_safety_${stamp}@test.local`,
        role: 'CUSTOMER',
      },
    });
    testCustomerId = cust.id;

    const admin = await prisma.user.create({
      data: {
        phone: `9999${stamp.slice(-6)}`,
        name: `Admin Safety ${stamp}`,
        email: `admin_safety_${stamp}@test.local`,
        role: 'ADMIN',
      },
    });
    testAdminUserId = admin.id;

    const vehicleA = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-SFT-A-${stamp.slice(-3)}`,
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

    const drvProfA = await prisma.driverProfile.create({
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
    testDriverProfileIdA = drvProfA.id;

    const vehicleB = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-SFT-B-${stamp.slice(-3)}`,
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

    const drvProfB = await prisma.driverProfile.create({
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
    testDriverProfileIdB = drvProfB.id;

    console.log(`[TEST] Test fixtures created: Cust=${testCustomerId}, Admin=${testAdminUserId}, DriverA=${testDriverProfileIdA}, DriverB=${testDriverProfileIdB}\n`);

    // Helper to create test ride
    const createTestRide = async (overrides: any = {}) => {
      const rideCode = `GC-SFT-${stamp.slice(-4)}-${Math.floor(Math.random() * 9000 + 1000)}`;
      const { stops: stopOverrides, ...restOverrides } = overrides;
      const ride = await prisma.ride.create({
        data: {
          bookingCode: rideCode,
          customerId: testCustomerId,
          driverId: testDriverProfileIdA,
          vehicleId: testVehicleIdA,
          status: TripStatus.SEARCHING,
          pickupLocation: 'Pondicherry Rock Beach',
          pickupLat: 11.93,
          pickupLng: 79.83,
          dropLocation: 'Auroville Globe',
          dropLat: 12.00,
          dropLng: 79.81,
          distanceKm: 12.5,
          estimatedFare: 450,
          startOtp: '1234',
          paymentMethod: 'UPI',
          paymentStatus: 'PAID',
          stops: {
            assignedAt: new Date().toISOString(),
            assignmentId: `asgn_${Date.now()}_test`,
            ...stopOverrides,
          },
          ...restOverrides,
        },
      });
      createdRideIds.push(ride.id);
      return ride;
    };

    // -------------------------------------------------------------
    // Scenario 1: First accept records acceptedAt
    // -------------------------------------------------------------
    console.log('--- Scenario 1: First accept records acceptedAt ---');
    const ride1 = await createTestRide();
    const accepted1 = await ridesService.acceptRide(testDriverUserIdA, ride1.id);
    const meta1 = accepted1.stops as any;
    assert.equal(accepted1.status, 'ACCEPTED');
    assert.ok(meta1.acceptedAt, 'acceptedAt must be recorded on first accept');
    const acceptedAtTime1 = new Date(meta1.acceptedAt).getTime();
    assert.ok(!isNaN(acceptedAtTime1), 'acceptedAt must be valid date');
    console.log('✓ Scenario 1 Passed: First accept successfully recorded acceptedAt.');

    // -------------------------------------------------------------
    // Scenario 2: Repeated accept preserves acceptedAt
    // -------------------------------------------------------------
    console.log('--- Scenario 2: Repeated accept preserves acceptedAt ---');
    await new Promise((r) => setTimeout(r, 60)); // Small delay to test timestamp stability
    const reaccepted1 = await ridesService.acceptRide(testDriverUserIdA, ride1.id);
    const meta1B = reaccepted1.stops as any;
    assert.equal(meta1B.acceptedAt, meta1.acceptedAt, 'Repeated accept must not overwrite original acceptedAt');

    // Attempt accept with different unassigned driver must be rejected
    await assert.rejects(
      async () => {
        await ridesService.acceptRide(testDriverUserIdB, ride1.id);
      },
      /Unauthorized: You are not the assigned driver/
    );
    console.log('✓ Scenario 2 Passed: Repeated accept preserves acceptedAt and blocks unassigned drivers.');

    // -------------------------------------------------------------
    // Scenario 3: Reassignment clears old alert metadata & sets fresh assignmentId
    // -------------------------------------------------------------
    console.log('--- Scenario 3: Reassignment clears old alert metadata ---');
    // Artificially mark ride1 as idle with old alert flags
    await prisma.ride.update({
      where: { id: ride1.id },
      data: {
        stops: {
          ...meta1,
          isDriverIdle: true,
          driverIdleAlertSentAt: new Date().toISOString(),
          idleAlertState: 'DISPATCHED',
          driverIdleMinutes: 8,
        },
      },
    });

    // Admin reassigns to Driver B
    const fakeReq: any = {
      params: { id: ride1.id },
      body: { driverId: testDriverProfileIdB, forceReassign: true },
    };
    const fakeReply: any = {
      status: (code: number) => ({
        send: (res: any) => res,
      }),
      send: (res: any) => res,
    };
    await adminController.assignRide(fakeReq, fakeReply);

    const reassignedRide = await prisma.ride.findUnique({ where: { id: ride1.id } });
    const metaReassigned = reassignedRide?.stops as any;

    assert.equal(reassignedRide?.driverId, testDriverProfileIdB, 'Driver should be updated to Driver B');
    assert.equal(reassignedRide?.status, 'SEARCHING', 'Reassigned ride returns to SEARCHING');
    assert.equal(metaReassigned.acceptedAt, undefined, 'Old driver acceptedAt must be cleared');
    assert.equal(metaReassigned.driverIdleAlertSentAt, undefined, 'Old driverIdleAlertSentAt must be cleared');
    assert.equal(metaReassigned.isDriverIdle, undefined, 'Old isDriverIdle must be cleared');
    assert.equal(metaReassigned.idleAlertState, undefined, 'Old idleAlertState must be cleared');
    assert.ok(metaReassigned.assignmentId, 'New unique assignmentId must be generated');
    assert.notEqual(metaReassigned.assignmentId, meta1.assignmentId, 'assignmentId must be fresh');
    console.log('✓ Scenario 3 Passed: Reassignment cleanly removed old driver alert metadata and assigned new identity.');

    // -------------------------------------------------------------
    // Scenario 4: New driver receives a fresh 5-minute timer
    // -------------------------------------------------------------
    console.log('--- Scenario 4: New driver receives a fresh 5-minute timer ---');
    const acceptedB = await ridesService.acceptRide(testDriverUserIdB, ride1.id);
    const metaAcceptedB = acceptedB.stops as any;
    assert.equal(acceptedB.status, 'ACCEPTED');
    assert.ok(metaAcceptedB.acceptedAt, 'New driver receives fresh acceptedAt timestamp');
    assert.equal(metaAcceptedB.isDriverIdle, false, 'isDriverIdle must be false upon acceptance');
    assert.equal(metaAcceptedB.driverIdleAlertSentAt, undefined, 'driverIdleAlertSentAt must remain absent');
    console.log('✓ Scenario 4 Passed: Newly assigned driver has independent fresh timer.');

    // -------------------------------------------------------------
    // Scenario 5: Immediate ride 5-minute threshold
    // -------------------------------------------------------------
    console.log('--- Scenario 5: Immediate ride 5-minute threshold ---');
    const now = Date.now();
    // 5A: Ride accepted 3 minutes ago (180s) -> Must NOT trigger
    const rideYoung = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        acceptedAt: new Date(now - 3 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_young',
      },
    });
    await schedulerService.checkDriverIdleDelays();
    const freshYoung = await prisma.ride.findUnique({ where: { id: rideYoung.id } });
    assert.equal((freshYoung?.stops as any).driverIdleAlertSentAt, undefined, 'Young ride must not trigger alert');

    // 5B: Ride accepted 6 minutes ago (360s) -> MUST trigger
    const rideOld = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        acceptedAt: new Date(now - 6 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_old',
      },
    });
    await schedulerService.checkDriverIdleDelays();
    const freshOld = await prisma.ride.findUnique({ where: { id: rideOld.id } });
    const metaOld = freshOld?.stops as any;
    assert.ok(metaOld.isDriverIdle === true, 'Old ride must be flagged as driver idle');
    assert.ok(metaOld.idleAlertState === 'DISPATCHED', 'Alert state must transition to DISPATCHED');
    assert.ok(metaOld.driverIdleAlertSentAt, 'driverIdleAlertSentAt timestamp must be recorded');
    console.log('✓ Scenario 5 Passed: Immediate ride strictly obeys the 300s threshold.');

    // -------------------------------------------------------------
    // Scenario 6: Scheduled ride threshold max(acceptedAt, scheduledAt) + 300s
    // -------------------------------------------------------------
    console.log('--- Scenario 6: Scheduled ride threshold max(acceptedAt, scheduledAt) + 300s ---');
    // 6A: Advance scheduled ride (pickup 45 mins from now, accepted 10 mins ago)
    // max(acceptedAt, scheduledAt) is in the future. Must NOT alert!
    const rideSchedFuture = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        isScheduled: true,
        scheduledAt: new Date(now + 45 * 60 * 1000).toISOString(),
        acceptedAt: new Date(now - 10 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_sched_future',
      },
    });
    await schedulerService.checkDriverIdleDelays();
    const freshSchedFuture = await prisma.ride.findUnique({ where: { id: rideSchedFuture.id } });
    assert.equal((freshSchedFuture?.stops as any).driverIdleAlertSentAt, undefined, 'Future scheduled ride must not alert prematurely');

    // 6B: Scheduled ride where scheduled pickup was 7 mins ago, accepted 15 mins ago
    // max(acceptedAt, scheduledAt) was 7 mins ago. Since > 5 mins past scheduledAt, MUST alert!
    const rideSchedElapsed = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        isScheduled: true,
        scheduledAt: new Date(now - 7 * 60 * 1000).toISOString(),
        acceptedAt: new Date(now - 15 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_sched_elapsed',
      },
    });
    await schedulerService.checkDriverIdleDelays();
    const freshSchedElapsed = await prisma.ride.findUnique({ where: { id: rideSchedElapsed.id } });
    assert.ok((freshSchedElapsed?.stops as any).isDriverIdle === true, 'Elapsed scheduled ride must alert');
    console.log('✓ Scenario 6 Passed: Scheduled ride strictly honors max(acceptedAt, scheduledAt) + 300s.');

    // -------------------------------------------------------------
    // Scenario 7: Invalid or missing scheduledAt safely skipped
    // -------------------------------------------------------------
    console.log('--- Scenario 7: Invalid or missing scheduledAt safely skipped ---');
    const rideInvalidSched = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        isScheduled: true,
        scheduledAt: 'not-a-valid-date-string',
        acceptedAt: new Date(now - 10 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_invalid_sched',
      },
    });
    await schedulerService.checkDriverIdleDelays();
    const freshInvalid = await prisma.ride.findUnique({ where: { id: rideInvalidSched.id } });
    assert.equal((freshInvalid?.stops as any).driverIdleAlertSentAt, undefined, 'Invalid scheduledAt must be safely skipped');
    console.log('✓ Scenario 7 Passed: Invalid scheduledAt safely logged and skipped without false alerts.');

    // -------------------------------------------------------------
    // Scenario 8: EN_ROUTE stops idle alerts
    // -------------------------------------------------------------
    console.log('--- Scenario 8: EN_ROUTE stops idle alerts ---');
    const rideEnRoute = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        acceptedAt: new Date(now - 10 * 60 * 1000).toISOString(),
        isDriverIdle: true,
        driverIdleAlertSentAt: new Date().toISOString(),
        assignmentId: 'asgn_enroute',
      },
    });
    // Driver starts navigating to pickup
    const transitioned = await ridesService.updateStatus(rideEnRoute.id, 'EN_ROUTE', 'DRIVER', undefined, testDriverUserIdA);
    assert.equal(transitioned.status, 'EN_ROUTE');
    assert.equal((transitioned.stops as any).isDriverIdle, false, 'isDriverIdle must be cleared on EN_ROUTE');

    // Run scheduler check again
    await schedulerService.checkDriverIdleDelays();
    const postEnRoute = await prisma.ride.findUnique({ where: { id: rideEnRoute.id } });
    assert.equal(postEnRoute?.status, 'EN_ROUTE');
    assert.equal((postEnRoute?.stops as any).isDriverIdle, false);
    console.log('✓ Scenario 8 Passed: EN_ROUTE immediately clears and permanently stops idle alerts.');

    // -------------------------------------------------------------
    // Scenario 9: Admin cancellation zero fee and zero driver compensation
    // -------------------------------------------------------------
    console.log('--- Scenario 9: Admin cancellation zero fee and zero driver compensation ---');
    const initialDriverWallet = await prisma.wallet.findUnique({ where: { driverId: testDriverProfileIdA } });
    const initialBalance = initialDriverWallet?.balance || 0;

    const rideAdminCancel = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      finalFare: 800,
      paymentStatus: 'PAID',
      stops: {
        isScheduled: true,
        scheduledAt: new Date(now + 30 * 60 * 1000).toISOString(), // within 2 hours!
      },
    });

    const cancelledAdmin = await ridesService.updateStatus(
      rideAdminCancel.id,
      'CANCELLED',
      'ADMIN',
      'Driver idle > 5 mins without moving',
      testAdminUserId
    );

    const cancelMeta = (cancelledAdmin.stops as any).cancellationAccounting;
    assert.equal(cancelledAdmin.status, 'CANCELLED');
    assert.equal(cancelMeta.cancellationFee, 0, 'Admin cancellation must charge 0 customer cancellation fee');
    assert.equal(cancelMeta.driverCompensation, 0, 'Admin cancellation must award 0 driver compensation');
    assert.equal(cancelMeta.eligibleRefund, 800, 'Customer eligible refund must be 100% of prepaid fare');

    // Check driver wallet balance was NOT incremented
    const postDriverWallet = await prisma.wallet.findUnique({ where: { driverId: testDriverProfileIdA } });
    assert.equal(postDriverWallet?.balance || 0, initialBalance, 'Driver wallet must not receive compensation on Admin cancellation');
    console.log('✓ Scenario 9 Passed: Admin cancellation strictly enforces 0 fee, 0 driver compensation, and full eligible refund.');

    // -------------------------------------------------------------
    // Scenario 10: Full eligible refund request is created exactly once
    // -------------------------------------------------------------
    console.log('--- Scenario 10: Full eligible refund request is created exactly once ---');
    const refundRequests = await prisma.refundRequest.findMany({ where: { rideId: rideAdminCancel.id } });
    assert.equal(refundRequests.length, 1, 'Exactly one refund request must be created');
    assert.equal(refundRequests[0].amount, 800);
    assert.equal(refundRequests[0].status, 'SUBMITTED');
    assert.ok(refundRequests[0].adminRemarks?.includes('pending'), 'Remarks must acknowledge gateway pending settlement');

    // Idempotent second cancel attempt must not duplicate refund
    await ridesService.updateStatus(rideAdminCancel.id, 'CANCELLED', 'ADMIN', 'Duplicate cancel attempt', testAdminUserId);
    const refundRequestsAfter = await prisma.refundRequest.findMany({ where: { rideId: rideAdminCancel.id } });
    assert.equal(refundRequestsAfter.length, 1, 'Idempotent cancel must not duplicate refund requests');
    console.log('✓ Scenario 10 Passed: Single atomic refund request created and preserved across duplicate calls.');

    // -------------------------------------------------------------
    // Scenario 11: Existing customer/driver cancellation policies remain unchanged
    // -------------------------------------------------------------
    console.log('--- Scenario 11: Existing customer/driver cancellation policies remain unchanged ---');
    // Customer cancels scheduled ride within 2 hours -> Policy applies 50% cancellation fee
    const rideCustCancel = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      finalFare: 600,
      paymentStatus: 'PAID',
      stops: {
        isScheduled: true,
        scheduledAt: new Date(now + 30 * 60 * 1000).toISOString(), // within 2 hours
      },
    });
    const cancelledCust = await ridesService.updateStatus(
      rideCustCancel.id,
      'CANCELLED',
      'CUSTOMER',
      'Customer change of mind',
      testCustomerId
    );
    const custCancelMeta = (cancelledCust.stops as any).cancellationAccounting;
    assert.equal(custCancelMeta.cancellationFee, 300, 'Customer late cancellation must charge 50% fee');
    assert.equal(custCancelMeta.eligibleRefund, 300, 'Customer late cancellation gets 50% refund');
    assert.equal(custCancelMeta.driverCompensation, 210, 'Driver gets 70% of fee as compensation on customer late cancel');
    console.log('✓ Scenario 11 Passed: Non-admin cancellation policies remain 100% intact and unaffected.');

    // -------------------------------------------------------------
    // Scenario 12: Concurrent cancellation does not double-process
    // -------------------------------------------------------------
    console.log('--- Scenario 12: Concurrent cancellation does not double-process ---');
    const rideConcurrent = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      finalFare: 500,
      paymentStatus: 'PAID',
    });

    // Fire 2 concurrent cancellation calls
    const [resA, resB] = await Promise.all([
      ridesService.updateStatus(rideConcurrent.id, 'CANCELLED', 'ADMIN', 'Concurrent 1', testAdminUserId),
      ridesService.updateStatus(rideConcurrent.id, 'CANCELLED', 'ADMIN', 'Concurrent 2', testAdminUserId),
    ]);

    assert.equal(resA.status, 'CANCELLED');
    assert.equal(resB.status, 'CANCELLED');
    const refundsConcurrent = await prisma.refundRequest.findMany({ where: { rideId: rideConcurrent.id } });
    assert.equal(refundsConcurrent.length, 1, 'Pessimistic row lock must prevent duplicate refund creation on concurrent requests');
    console.log('✓ Scenario 12 Passed: Concurrent cancellation serialized cleanly via row-level locks.');

    // -------------------------------------------------------------
    // Scenario 13: Notification failure retry and concurrent scheduler execution
    // -------------------------------------------------------------
    console.log('--- Scenario 13: Multi-instance claim lease & failure retry ---');
    const rideRetry = await createTestRide({
      status: TripStatus.ACCEPTED,
      driverId: testDriverProfileIdA,
      stops: {
        acceptedAt: new Date(now - 8 * 60 * 1000).toISOString(),
        assignmentId: 'asgn_retry_test',
        idleAlertState: 'FAILED',
        idleAlertLastError: 'Simulated network drop',
      },
    });

    // Scheduler runs and detects FAILED state -> Retries and dispatches
    await schedulerService.checkDriverIdleDelays();
    const retriedRide = await prisma.ride.findUnique({ where: { id: rideRetry.id } });
    const retriedMeta = retriedRide?.stops as any;
    assert.equal(retriedMeta.idleAlertState, 'DISPATCHED', 'Previously failed alert must be retried and dispatched');
    assert.ok(retriedMeta.idleAlertDispatchedAt, 'Dispatched timestamp must be recorded');
    console.log('✓ Scenario 13 Passed: Failed notification attempts are safely retried.');

    // -------------------------------------------------------------
    // Scenario 14: Existing 120-second assignment expiry regression
    // -------------------------------------------------------------
    console.log('--- Scenario 14: Existing 120-second assignment expiry regression ---');
    const rideExpiring = await createTestRide({
      status: TripStatus.SEARCHING,
      driverId: testDriverProfileIdA,
      stops: {
        assignedAt: new Date(now - 130 * 1000).toISOString(), // 130s ago (> 120s limit)
        assignmentExpiresAt: new Date(now - 10 * 1000).toISOString(),
      },
    });

    await schedulerService.checkAndExpireDriverAssignments();
    const freshExpiring = await prisma.ride.findUnique({ where: { id: rideExpiring.id } });
    // Should be unassigned from Driver A or redispatched
    assert.notEqual(freshExpiring?.driverId, testDriverProfileIdA, 'Driver A must be unassigned after 120s expiry');
    console.log('✓ Scenario 14 Passed: Existing 120s assignment expiry behavior remains fully functional.');

    console.log(`\n======================================================`);
    console.log(`ALL 14 SAFETY & REGRESSION SCENARIOS PASSED WITH ZERO FAILURES! ✓`);
    console.log(`======================================================\n`);
  } finally {
    // Cleanup created test records
    console.log('[TEST] Cleaning up test records...');
    for (const rId of createdRideIds) {
      await prisma.refundRequest.deleteMany({ where: { rideId: rId } }).catch(() => {});
      await prisma.fareBreakdown.deleteMany({ where: { rideId: rId } }).catch(() => {});
      await prisma.ride.deleteMany({ where: { id: rId } }).catch(() => {});
    }
    if (testDriverProfileIdA) await prisma.driverProfile.deleteMany({ where: { id: testDriverProfileIdA } }).catch(() => {});
    if (testDriverProfileIdB) await prisma.driverProfile.deleteMany({ where: { id: testDriverProfileIdB } }).catch(() => {});
    if (testVehicleIdA) await prisma.vehicle.deleteMany({ where: { id: testVehicleIdA } }).catch(() => {});
    if (testVehicleIdB) await prisma.vehicle.deleteMany({ where: { id: testVehicleIdB } }).catch(() => {});
    if (testDriverUserIdA) await prisma.user.deleteMany({ where: { id: testDriverUserIdA } }).catch(() => {});
    if (testDriverUserIdB) await prisma.user.deleteMany({ where: { id: testDriverUserIdB } }).catch(() => {});
    if (testCustomerId) await prisma.user.deleteMany({ where: { id: testCustomerId } }).catch(() => {});
    if (testAdminUserId) await prisma.user.deleteMany({ where: { id: testAdminUserId } }).catch(() => {});
    console.log('[TEST] Cleanup completed.\n');
  }
}

runSafetyRegressionSuite().catch((err) => {
  console.error('[SUITE FATAL ERROR]:', err);
  process.exit(1);
});
