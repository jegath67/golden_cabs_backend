import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { ridesService } from '../src/modules/rides/rides.service';

async function main() {
  console.log('======================================================');
  console.log('[TEST] Starting Customer Ride Concurrency & Overlap Suite');
  console.log('======================================================\n');

  const stamp = Date.now();
  const createdRideIds: string[] = [];
  const createdUserIds: string[] = [];

  const cleanup = async () => {
    console.log('\n[TEST] Cleaning up test records...');
    for (const rId of createdRideIds) {
      await prisma.ride.deleteMany({ where: { id: rId } }).catch(() => {});
    }
    for (const uId of createdUserIds) {
      await prisma.user.deleteMany({ where: { id: uId } }).catch(() => {});
    }
    console.log('[TEST] Cleanup completed.');
  };

  try {
    // Create test customer
    const custUser = await prisma.user.create({
      data: {
        phone: `+9198765${stamp.toString().slice(-5)}`,
        name: `Test Customer ${stamp}`,
        role: 'CUSTOMER',
        isActive: true,
      },
    });
    createdUserIds.push(custUser.id);

    console.log('--- Test 1: "For Me" Instant Ride (Now) - Single active ride allowed ---');
    const ride1 = await ridesService.requestRide(custUser.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville',
      dropLat: 11.98,
      dropLng: 79.81,
      skipAvailabilityCheck: true,
      riderName: 'For me',
    });
    createdRideIds.push(ride1.id);
    assert.equal(ride1.status, 'SEARCHING');
    console.log('✓ Ride 1 ("For Me") created successfully');

    // Attempting 2nd "For Me" instant ride while Ride 1 is active MUST fail
    let forMeDuplicateFailed = false;
    try {
      await ridesService.requestRide(custUser.id, {
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville',
        dropLat: 11.98,
        dropLng: 79.81,
        skipAvailabilityCheck: true,
        riderName: 'For me',
      });
    } catch (err: any) {
      forMeDuplicateFailed = true;
      assert.ok(err.message.includes('already have an active ride in progress'), `Unexpected error message: ${err.message}`);
    }
    assert.equal(forMeDuplicateFailed, true, 'Second "For Me" instant ride must be rejected');
    console.log('✓ Test 1 Passed: Second "For Me" instant ride correctly rejected with 400.');

    console.log('\n--- Test 2: "For Another Person" Instant Ride - Allowed with different contact ---');
    const friendPhone1 = '+919111111111';
    const friendRide1 = await ridesService.requestRide(custUser.id, {
      pickupLocation: 'White Town',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Airport',
      dropLat: 11.97,
      dropLng: 79.82,
      skipAvailabilityCheck: true,
      riderName: 'Friend Alpha',
      riderPhone: friendPhone1,
    });
    createdRideIds.push(friendRide1.id);
    assert.equal(friendRide1.status, 'SEARCHING');
    console.log('✓ Friend Alpha ride created while "For Me" is active');

    // Attempting duplicate instant ride for Friend Alpha (same phone) MUST fail
    let friendDuplicateFailed = false;
    try {
      await ridesService.requestRide(custUser.id, {
        pickupLocation: 'White Town',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Railway Station',
        dropLat: 11.93,
        dropLng: 79.83,
        skipAvailabilityCheck: true,
        riderName: 'Friend Alpha Duplicate',
        riderPhone: friendPhone1,
      });
    } catch (err: any) {
      friendDuplicateFailed = true;
      assert.ok(err.message.includes('active ride is already in progress for contact'), `Unexpected error message: ${err.message}`);
    }
    assert.equal(friendDuplicateFailed, true, 'Duplicate instant ride for same contact must be rejected');
    console.log('✓ Test 2 Passed: Different contact instant ride allowed, duplicate for same contact rejected.');

    console.log('\n--- Test 3: "For Me" Scheduled Rides - Multiple on different times allowed ---');
    const tomorrow10am = new Date(Date.now() + 24 * 3600 * 1000);
    tomorrow10am.setHours(10, 0, 0, 0);

    const tomorrow4pm = new Date(Date.now() + 24 * 3600 * 1000);
    tomorrow4pm.setHours(16, 0, 0, 0);

    const schedRide1 = await ridesService.requestRide(custUser.id, {
      pickupLocation: 'Home',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Office',
      dropLat: 11.98,
      dropLng: 79.81,
      scheduledAt: tomorrow10am.toISOString(),
      skipAvailabilityCheck: true,
      riderName: 'For me',
    });
    createdRideIds.push(schedRide1.id);

    const schedRide2 = await ridesService.requestRide(custUser.id, {
      pickupLocation: 'Office',
      pickupLat: 11.98,
      pickupLng: 79.81,
      dropLocation: 'Home',
      dropLat: 11.9416,
      dropLng: 79.8083,
      scheduledAt: tomorrow4pm.toISOString(),
      skipAvailabilityCheck: true,
      riderName: 'For me',
    });
    createdRideIds.push(schedRide2.id);
    console.log('✓ Two "For Me" scheduled rides on different times (10:00 AM & 4:00 PM) created successfully');

    // Attempting overlapping "For Me" scheduled ride (10:15 AM - within 45 min buffer) MUST fail
    const tomorrow1015am = new Date(tomorrow10am.getTime() + 15 * 60 * 1000);
    let schedOverlapFailed = false;
    try {
      await ridesService.requestRide(custUser.id, {
        pickupLocation: 'Home',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Gym',
        dropLat: 11.95,
        dropLng: 79.82,
        scheduledAt: tomorrow1015am.toISOString(),
        skipAvailabilityCheck: true,
        riderName: 'For me',
      });
    } catch (err: any) {
      schedOverlapFailed = true;
      assert.ok(err.message.includes('already have a ride scheduled around this time'), `Unexpected error message: ${err.message}`);
    }
    assert.equal(schedOverlapFailed, true, 'Overlapping "For Me" scheduled ride must be rejected');
    console.log('✓ Test 3 Passed: "For Me" non-overlapping scheduled rides allowed, overlapping slot rejected.');

    console.log('\n--- Test 4: "For Another Person" Scheduled Rides - Same time for different contacts allowed ---');
    const friendPhone2 = '+919222222222';
    const friendSched1 = await ridesService.requestRide(custUser.id, {
      pickupLocation: 'Auroville',
      pickupLat: 11.98,
      pickupLng: 79.81,
      dropLocation: 'Airport',
      dropLat: 11.97,
      dropLng: 79.82,
      scheduledAt: tomorrow10am.toISOString(), // Same 10:00 AM slot as For Me!
      skipAvailabilityCheck: true,
      riderName: 'Friend Beta',
      riderPhone: friendPhone2,
    });
    createdRideIds.push(friendSched1.id);
    console.log('✓ Scheduled ride at same time (10:00 AM) for different person (Friend Beta) succeeded');

    // Attempting overlapping scheduled ride for the SAME contact (Friend Beta at 10:20 AM) MUST fail
    const tomorrow1020am = new Date(tomorrow10am.getTime() + 20 * 60 * 1000);
    let friendSchedDuplicateFailed = false;
    try {
      await ridesService.requestRide(custUser.id, {
        pickupLocation: 'Airport',
        pickupLat: 11.97,
        pickupLng: 79.82,
        dropLocation: 'Hotel',
        dropLat: 11.96,
        dropLng: 79.82,
        scheduledAt: tomorrow1020am.toISOString(),
        skipAvailabilityCheck: true,
        riderName: 'Friend Beta',
        riderPhone: friendPhone2,
      });
    } catch (err: any) {
      friendSchedDuplicateFailed = true;
      assert.ok(err.message.includes('ride is already scheduled for contact'), `Unexpected error message: ${err.message}`);
    }
    assert.equal(friendSchedDuplicateFailed, true, 'Overlapping scheduled ride for same contact must be rejected');
    console.log('✓ Test 4 Passed: Same time slot for different contacts allowed, duplicate contact rejected.');

    console.log('\n======================================================');
    console.log('ALL CUSTOMER RIDE CONCURRENCY & OVERLAP TESTS PASSED! ✓');
    console.log('======================================================');
  } catch (error) {
    console.error('[TEST] Failed with error:', error);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
