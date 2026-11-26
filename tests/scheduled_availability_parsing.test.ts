import { strict as assert } from 'assert';
import Fastify from 'fastify';
import { prisma } from '../src/config/prisma';
import { ridesRoutes } from '../src/modules/rides/rides.routes';
import { parseScheduledPickupTime, ridesService } from '../src/modules/rides/rides.service';
import { driverAvailabilityService } from '../src/modules/rides/driver-availability.service';
import { unavailabilityService } from '../src/modules/unavailability/unavailability.service';

/**
 * Format a Date in Customer App's exact Flutter label format:
 * DateFormat('EEE, dd MMM, hh:mm a') e.g. "Wed, 26 Nov, 05:30 PM"
 */
function formatFlutterScheduledLabel(d: Date): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const wk = weekdays[d.getDay()];
  const day = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hh = String(hours).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${wk}, ${day} ${mon}, ${hh}:${mm} ${ampm}`;
}

async function main() {
  const stamp = Date.now().toString();
  console.log('======================================================');
  console.log(`[TEST] Starting Scheduled Availability Date Parsing Suite (stamp: ${stamp})`);
  console.log('======================================================');

  const createdUserIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdRideIds: string[] = [];

  const fastify = Fastify();
  await fastify.register(ridesRoutes, { prefix: '/api/rides' });

  try {
    // Seed customer + offline approved 6-seater driver
    const customer = await prisma.user.create({
      data: {
        phone: `9799${stamp.slice(-6)}`,
        name: 'Sched Test Customer',
        email: `sched_cust_${stamp}@test.local`,
        role: 'CUSTOMER',
      },
    });
    createdUserIds.push(customer.id);

    const drvUser = await prisma.user.create({
      data: { phone: `9791${stamp.slice(-6)}`, name: 'Offline 6-Seater Driver', role: 'DRIVER' },
    });
    createdUserIds.push(drvUser.id);

    const veh6 = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-SC-6-${stamp.slice(-4)}`,
        brand: 'Toyota',
        model: 'Innova',
        year: 2024,
        category: 'PREMIUM',
        seatCapacity: 6,
        status: 'VERIFIED',
      },
    });
    createdVehicleIds.push(veh6.id);

    const drv6 = await prisma.driverProfile.create({
      data: {
        userId: drvUser.id,
        personaType: 'OWN_VEHICLE',
        approvalStatus: 'APPROVED',
        isOnline: false,
        shiftStatus: 'OFF_SHIFT',
        currentLatitude: 11.9416,
        currentLongitude: 79.8083,
        assignedVehicleId: veh6.id,
      },
    });
    createdDriverIds.push(drv6.id);

    // Deterministic future date (3 days from now, 05:30 PM local)
    const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    futureDate.setHours(17, 30, 0, 0);
    const flutterLabel = formatFlutterScheduledLabel(futureDate);
    const futureIso = futureDate.toISOString();

    // --- Test 1: Exact Flutter yearless format ("Wed, 26 Nov, 05:30 PM") ---
    console.log('\n--- Test 1: Exact Flutter yearless format parsing ---');
    const fixedSampleParsed = parseScheduledPickupTime('Wed, 26 Nov, 05:30 PM');
    assert.ok(fixedSampleParsed !== null, 'Exact sample "Wed, 26 Nov, 05:30 PM" must parse');
    assert.ok(
      fixedSampleParsed.getFullYear() >= new Date().getFullYear(),
      `Parsed year must be >= current year (got ${fixedSampleParsed.getFullYear()})`
    );

    const resFlutter = await fastify.inject({
      method: 'GET',
      url: `/api/rides/check-availability?pickupLat=11.9416&pickupLng=79.8083&scheduledAt=${encodeURIComponent(flutterLabel)}`,
    });
    assert.equal(resFlutter.statusCode, 200, `Expected 200 for Flutter label "${flutterLabel}"`);
    const bodyFlutter = JSON.parse(resFlutter.body);
    assert.equal(bodyFlutter.success, true);
    assert.equal(bodyFlutter.data.isScheduled, true, 'isScheduled must be true for Flutter scheduled label');
    assert.equal(bodyFlutter.data.sixSeater.available, true, 'Offline 6-seater must be available for scheduled ride');
    console.log(`✓ Test 1 Passed: Flutter format "${flutterLabel}" parsed with isScheduled=true and 6-seater available.`);

    // --- Test 2: ISO timestamp with year ---
    console.log('\n--- Test 2: ISO timestamp with year ---');
    const resIso = await fastify.inject({
      method: 'GET',
      url: `/api/rides/check-availability?pickupLat=11.9416&pickupLng=79.8083&scheduledAt=${encodeURIComponent(futureIso)}`,
    });
    assert.equal(resIso.statusCode, 200);
    const bodyIso = JSON.parse(resIso.body);
    assert.equal(bodyIso.data.isScheduled, true, 'isScheduled must be true for ISO timestamp');
    assert.equal(bodyIso.data.sixSeater.available, true);
    console.log('✓ Test 2 Passed: ISO timestamp with year parsed and evaluated as scheduled.');

    // --- Test 3: Valid scheduled time does not require currently online driver ---
    console.log('\n--- Test 3: Scheduled availability does not require currently online driver ---');
    const parsedFlutter = parseScheduledPickupTime(flutterLabel)!;
    const evalSchedOffline = await driverAvailabilityService.evaluateDriverAvailability(drv6.id, {
      id: 'test_sched_offline',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLat: 11.98,
      dropLng: 79.81,
      distanceKm: 10,
      tripType: 'Local One Way',
      isScheduled: true,
      scheduledAt: parsedFlutter,
      seatCapacity: 6,
      isElite: false,
      category: 'REGULAR',
    });
    assert.equal(evalSchedOffline.isAvailable, true, 'Offline driver must be eligible for future scheduled ride');
    console.log('✓ Test 3 Passed: Offline/OFF_SHIFT driver is eligible for future scheduled ride.');

    // --- Test 4: Scheduled availability uses correct target date for unavailability checks ---
    console.log('\n--- Test 4: Scheduled unavailability check uses parsed future target date ---');
    const targetDateStr = unavailabilityService.normalizeDate(parsedFlutter);
    await unavailabilityService.saveSchedule(drv6.id, veh6.id, [targetDateStr], 'Test Maintenance');

    const evalBlocked = await driverAvailabilityService.evaluateDriverAvailability(drv6.id, {
      id: 'test_sched_blocked',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLat: 11.98,
      dropLng: 79.81,
      distanceKm: 10,
      tripType: 'Local One Way',
      isScheduled: true,
      scheduledAt: parsedFlutter,
      seatCapacity: 6,
      isElite: false,
      category: 'REGULAR',
    });
    assert.equal(evalBlocked.isAvailable, false, 'Driver blocked on target future date must be unavailable');
    assert.equal(evalBlocked.reasonCode, 'SCHEDULED_UNAVAILABLE');

    // Clear unavailability for subsequent tests
    await unavailabilityService.saveSchedule(drv6.id, veh6.id, []);
    console.log(`✓ Test 4 Passed: Unavailability checked against target date ${targetDateStr}.`);

    // --- Test 5: Invalid scheduled date returns 400 ---
    console.log('\n--- Test 5: Invalid scheduled date returns 400 ---');
    const resInvalid = await fastify.inject({
      method: 'GET',
      url: '/api/rides/check-availability?pickupLat=11.9416&pickupLng=79.8083&scheduledAt=not-a-valid-date',
    });
    assert.equal(resInvalid.statusCode, 400, 'Invalid scheduledAt must return HTTP 400');
    const bodyInvalid = JSON.parse(resInvalid.body);
    assert.equal(bodyInvalid.success, false);
    console.log('✓ Test 5 Passed: Invalid scheduled date cleanly returned 400.');

    // --- Test 6: Immediate ride availability behavior remains unchanged ---
    console.log('\n--- Test 6: Immediate ride availability behavior unchanged ---');
    const evalImmediateOffline = await driverAvailabilityService.evaluateDriverAvailability(drv6.id, {
      id: 'test_imm_offline',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLat: 11.98,
      dropLng: 79.81,
      distanceKm: 10,
      tripType: 'Local One Way',
      isScheduled: false,
      scheduledAt: null,
      seatCapacity: 6,
      isElite: false,
      category: 'REGULAR',
    });
    assert.equal(evalImmediateOffline.isAvailable, false, 'Offline driver must remain ineligible for immediate ride');
    assert.equal(evalImmediateOffline.reasonCode, 'DRIVER_OFF_SHIFT');

    const resPickUpNow = await fastify.inject({
      method: 'GET',
      url: '/api/rides/check-availability?pickupLat=11.9416&pickupLng=79.8083&scheduledAt=Pick-up%20now',
    });
    assert.equal(resPickUpNow.statusCode, 200);
    assert.equal(JSON.parse(resPickUpNow.body).data.isScheduled, false);
    console.log('✓ Test 6 Passed: Immediate ride availability and "Pick-up now" behavior unchanged.');

    // --- Test 7: Existing requestRide scheduled booking behavior remains unchanged ---
    console.log('\n--- Test 7: Existing requestRide scheduled booking behavior unchanged ---');
    const schedRide = await ridesService.requestRide(customer.id, {
      pickupLocation: 'White Town, Puducherry',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville, Puducherry',
      dropLat: 11.98,
      dropLng: 79.81,
      requestedSeats: '6 Seater Cab',
      seatCapacity: 6,
      scheduledAt: flutterLabel,
    });
    createdRideIds.push(schedRide.id);
    assert.equal(schedRide.status, 'SEARCHING');
    const rideMeta = (schedRide.stops as any) || {};
    assert.equal(rideMeta.isScheduled, true);
    assert.ok(rideMeta.scheduledAt && new Date(rideMeta.scheduledAt).getFullYear() >= new Date().getFullYear());
    console.log('✓ Test 7 Passed: requestRide() scheduled booking with Flutter label works unchanged.');

    console.log('\n======================================================');
    console.log('ALL 7 SCHEDULED AVAILABILITY REGRESSION TESTS PASSED! ✓');
    console.log('======================================================');
  } finally {
    console.log('\n[TEST] Cleaning up test records...');
    for (const dId of createdDriverIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM "UnavailabilitySchedule" WHERE "driverId" = $1`, dId);
    }
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
    await fastify.close();
    await prisma.$disconnect();
    console.log('[TEST] Cleanup completed.');
  }
}

main().catch((err) => {
  console.error('[TEST] Failed with error:', err);
  process.exit(1);
});
