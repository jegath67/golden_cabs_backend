import { strict as assert } from 'assert';
import { prisma } from '../src/config/prisma';
import { driverAvailabilityService } from '../src/modules/rides/driver-availability.service';
import { ridesService } from '../src/modules/rides/rides.service';
import Fastify from 'fastify';
import { ridesRoutes } from '../src/modules/rides/rides.routes';

async function main() {
  const stamp = Date.now().toString();
  console.log(`======================================================`);
  console.log(`[TEST] Starting 4/6 Seater Category Availability Test Suite (stamp: ${stamp})`);
  console.log(`======================================================`);

  const createdUserIds: string[] = [];
  const createdDriverProfileIds: string[] = [];
  const createdVehicleIds: string[] = [];
  const createdRideIds: string[] = [];

  try {
    // 1. Create a customer
    const customer = await prisma.user.create({
      data: {
        phone: `9899${stamp.slice(-6)}`,
        name: 'Test Customer',
        email: `cust_${stamp}@test.local`,
        role: 'CUSTOMER',
      },
    });
    createdUserIds.push(customer.id);

    // 2. Create Driver 1 (4-seater Sedan, Online, On-shift, Approved)
    const userDrv4 = await prisma.user.create({
      data: { phone: `9891${stamp.slice(-6)}`, name: 'Driver 4-Seater', role: 'DRIVER' },
    });
    createdUserIds.push(userDrv4.id);

    const veh4 = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-01-V4-${stamp.slice(-4)}`,
        brand: 'Maruti',
        model: 'Dzire',
        year: 2023,
        category: 'BUDGET',
        seatCapacity: 4,
        status: 'VERIFIED',
      },
    });
    createdVehicleIds.push(veh4.id);

    const drv4 = await prisma.driverProfile.create({
      data: {
        userId: userDrv4.id,
        personaType: 'OWN_VEHICLE',
        approvalStatus: 'APPROVED',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        currentLatitude: 11.9416,
        currentLongitude: 79.8083,
        assignedVehicleId: veh4.id,
      },
    });
    createdDriverProfileIds.push(drv4.id);

    // Ensure any pre-existing unassigned SEARCHING deficit in the local dev DB is offset
    for (let pad = 0; pad < 10; pad++) {
      const check = await driverAvailabilityService.checkCategoryAvailability({
        pickupLat: 11.9416,
        pickupLng: 79.8083,
      });
      if (check.fourSeater.count >= 1) break;
      const uPad = await prisma.user.create({
        data: { phone: `988${pad}${stamp.slice(-5)}`.slice(0, 10), name: `Pad 4S ${pad}`, role: 'DRIVER' },
      });
      createdUserIds.push(uPad.id);
      const vPad = await prisma.vehicle.create({
        data: {
          vehicleNumber: `TN-PD-${pad}-${stamp.slice(-4)}`,
          brand: 'Maruti',
          model: 'Dzire',
          year: 2023,
          category: 'BUDGET',
          seatCapacity: 4,
          status: 'VERIFIED',
        },
      });
      createdVehicleIds.push(vPad.id);
      const dPad = await prisma.driverProfile.create({
        data: {
          userId: uPad.id,
          personaType: 'OWN_VEHICLE',
          approvalStatus: 'APPROVED',
          isOnline: true,
          shiftStatus: 'ON_SHIFT',
          currentLatitude: 11.9416,
          currentLongitude: 79.8083,
          assignedVehicleId: vPad.id,
        },
      });
      createdDriverProfileIds.push(dPad.id);
    }

    // --- Scenario 1: Only 4-seater is available ---
    console.log('\n--- Scenario 1: Only 4-seater available in pickup area ---');
    const avail1 = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });

    assert.equal(avail1.fourSeater.available, true, '4-seater must be reported available');
    assert.ok(avail1.fourSeater.count >= 1, '4-seater count must be at least 1');
    assert.equal(avail1.sixSeater.available, false, '6-seater must NOT be available when only 4-seater driver exists');
    assert.equal(avail1.sixSeater.count, 0, '6-seater count must be 0');
    console.log('✓ Scenario 1 Passed: 4-seater available, 6-seater unavailable.');

    // --- Scenario 2: Immediate booking request for 6-seater rejected with 409 ---
    console.log('\n--- Scenario 2: Immediate 6-seater booking rejected with 409 CATEGORY_UNAVAILABLE ---');
    let rejectedWith409 = false;
    try {
      await ridesService.requestRide(customer.id, {
        pickupLocation: 'White Town, Puducherry',
        pickupLat: 11.9416,
        pickupLng: 79.8083,
        dropLocation: 'Auroville, Puducherry',
        dropLat: 11.9800,
        dropLng: 79.8100,
        requestedSeats: '6 Seater Cab',
        seatCapacity: 6,
      });
    } catch (err: any) {
      if (err.statusCode === 409 && err.code === 'CATEGORY_UNAVAILABLE') {
        rejectedWith409 = true;
        assert.ok(err.message.includes('6-Seater cabs are currently not available'));
      }
    }
    assert.equal(rejectedWith409, true, 'Immediate 6-seater request must throw 409 CATEGORY_UNAVAILABLE');
    console.log('✓ Scenario 2 Passed: 6-seater request cleanly rejected with HTTP 409 without creating stranded ride.');

    // --- Scenario 3: Immediate booking request for 4-seater succeeds ---
    console.log('\n--- Scenario 3: Immediate 4-seater booking succeeds when 4-seater available ---');
    const ride4 = await ridesService.requestRide(customer.id, {
      pickupLocation: 'White Town, Puducherry',
      pickupLat: 11.9416,
      pickupLng: 79.8083,
      dropLocation: 'Auroville, Puducherry',
      dropLat: 11.9800,
      dropLng: 79.8100,
      requestedSeats: '4 Seater Cab',
      seatCapacity: 4,
    });
    createdRideIds.push(ride4.id);
    assert.equal(ride4.status, 'SEARCHING', 'Ride must be created in SEARCHING status');
    console.log('✓ Scenario 3 Passed: 4-seater ride created successfully.');

    // --- Scenario 4: Driver 2 (6-seater Innova, Online, On-shift, Approved) comes online ---
    console.log('\n--- Scenario 4: 6-seater vehicle comes online and serves ONLY 6-seater (strict isolation) ---');
    const userDrv6 = await prisma.user.create({
      data: { phone: `9892${stamp.slice(-6)}`, name: 'Driver 6-Seater', role: 'DRIVER' },
    });
    createdUserIds.push(userDrv6.id);

    const veh6 = await prisma.vehicle.create({
      data: {
        vehicleNumber: `TN-01-V6-${stamp.slice(-4)}`,
        brand: 'Toyota',
        model: 'Innova',
        year: 2023,
        category: 'PREMIUM',
        seatCapacity: 6,
        status: 'VERIFIED',
      },
    });
    createdVehicleIds.push(veh6.id);

    const drv6 = await prisma.driverProfile.create({
      data: {
        userId: userDrv6.id,
        personaType: 'OWN_VEHICLE',
        approvalStatus: 'APPROVED',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        currentLatitude: 11.9420,
        currentLongitude: 79.8090,
        assignedVehicleId: veh6.id,
      },
    });
    createdDriverProfileIds.push(drv6.id);

    const avail2 = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });

    assert.equal(avail2.sixSeater.available, true, '6-seater must now be available');
    assert.ok(avail2.sixSeater.count >= 1, '6-seater count >= 1');
    assert.equal(
      avail2.fourSeater.count,
      avail1.fourSeater.count - 1,
      '4-seater count must NOT increase when 6-seater comes online, and ride4 reserves 1 4-seater slot'
    );
    console.log('✓ Scenario 4 Passed: 6-seater driver serves only 6-seater; 4-seater capacity remains isolated and reserved by ride4.');

    // --- Scenario 5: Offline driver is excluded ---
    console.log('\n--- Scenario 5: Offline driver is excluded from immediate availability ---');
    await prisma.driverProfile.update({
      where: { id: drv6.id },
      data: { isOnline: false },
    });

    const avail3 = await driverAvailabilityService.checkCategoryAvailability({
      pickupLat: 11.9416,
      pickupLng: 79.8083,
    });
    assert.equal(avail3.sixSeater.available, false, '6-seater must be unavailable when 6-seater driver is offline');
    console.log('✓ Scenario 5 Passed: Offline driver excluded from immediate availability.');

    // --- Scenario 6: Fastify HTTP endpoint verification ---
    console.log('\n--- Scenario 6: GET /api/rides/check-availability Fastify endpoint ---');
    const fastify = Fastify();
    await fastify.register(ridesRoutes, { prefix: '/api/rides' });

    // Test valid GET
    const resGet = await fastify.inject({
      method: 'GET',
      url: '/api/rides/check-availability?pickupLat=11.9416&pickupLng=79.8083',
    });
    assert.equal(resGet.statusCode, 200);
    const bodyGet = JSON.parse(resGet.body);
    assert.equal(bodyGet.success, true);
    assert.ok('fourSeater' in bodyGet.data);
    assert.ok('sixSeater' in bodyGet.data);

    // Test invalid GET (missing coordinates)
    const resInvalid = await fastify.inject({
      method: 'GET',
      url: '/api/rides/check-availability',
    });
    assert.equal(resInvalid.statusCode, 400);
    console.log('✓ Scenario 6 Passed: Fastify GET /check-availability works cleanly with 200 and 400 validation.');

    console.log(`\n======================================================`);
    console.log(`ALL 6 CATEGORY AVAILABILITY SCENARIOS PASSED WITH ZERO FAILURES! ✓`);
    console.log(`======================================================`);
  } finally {
    console.log('\n[TEST] Cleaning up test records...');
    for (const rId of createdRideIds) {
      await prisma.ride.deleteMany({ where: { id: rId } });
    }
    for (const dId of createdDriverProfileIds) {
      await prisma.driverProfile.deleteMany({ where: { id: dId } });
    }
    for (const vId of createdVehicleIds) {
      await prisma.vehicle.deleteMany({ where: { id: vId } });
    }
    for (const uId of createdUserIds) {
      await prisma.user.deleteMany({ where: { id: uId } });
    }
    console.log('[TEST] Cleanup completed.');
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[TEST] Failed with error:', err);
  process.exit(1);
});
