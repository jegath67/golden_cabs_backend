import { prisma } from '../src/config/prisma';
import { RidesService } from '../src/modules/rides/rides.service';

async function main() {
  console.log('--- STARTING PHASE 1 ONLINE PAYMENT SYNC TEST ---');
  const ridesService = new RidesService();

  // Find a test driver profile
  const driver = await prisma.driverProfile.findFirst({
    include: { wallet: true, user: true },
  });
  if (!driver) {
    throw new Error('No driverProfile found in database for testing');
  }

  // Ensure driver has a wallet
  let wallet = driver.wallet;
  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: {
        driverId: driver.id,
        balance: 1000,
        currency: 'INR',
      },
    });
  }

  // Find or create a customer user
  let customer = await prisma.user.findFirst({
    where: { role: 'CUSTOMER' },
  });
  if (!customer) {
    customer = await prisma.user.create({
      data: {
        phone: '+919999900001',
        name: 'Test Customer',
        role: 'CUSTOMER',
        customerProfile: {
          create: {},
        },
      },
    });
  }

  console.log(`Using DriverProfile: ${driver.id} (${driver.user.name}), Customer: ${customer.id} (${customer.name})`);

  const testRideIds: string[] = [];

  try {
    // ----------------------------------------------------
    // TEST 1: Cash ride completion
    // ----------------------------------------------------
    console.log('\n[Test 1] Testing CASH ride completion...');
    const cashRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-TEST-CASH-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'CASH',
        paymentStatus: 'PENDING',
        distanceKm: 5.0,
        estimatedFare: 400,
        finalFare: 400,
        pickupLocation: 'Test Pickup Loc',
        pickupAddress: 'Test Pickup Address',
        pickupLat: 11.934,
        pickupLng: 79.830,
        dropLocation: 'Test Drop Loc',
        dropAddress: 'Test Drop Address',
        dropLat: 11.940,
        dropLng: 79.835,
        startOtp: '1234',
      },
    });
    testRideIds.push(cashRide.id);

    const initialWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });
    console.log(`Initial driver wallet balance: ₹${initialWallet.balance}`);

    // Complete cash ride
    const completedCashRide = await ridesService.completeRide(cashRide.id);
    console.log(`Cash ride completed. Status: ${completedCashRide.status}, PaymentStatus: ${completedCashRide.paymentStatus}`);

    if (completedCashRide.status !== 'COMPLETED' || completedCashRide.paymentStatus !== 'PAID') {
      throw new Error(`Test 1 Failed: Expected COMPLETED and PAID, got ${completedCashRide.status} and ${completedCashRide.paymentStatus}`);
    }

    const postCashWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });
    console.log(`Post-cash driver wallet balance: ₹${postCashWallet.balance} (debited commission: ₹${initialWallet.balance - postCashWallet.balance})`);

    const commissionTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.id,
        referenceRideId: cashRide.id,
        type: 'COMMISSION',
      },
    });
    if (!commissionTx) {
      throw new Error('Test 1 Failed: Expected COMMISSION wallet transaction for cash ride!');
    }
    console.log(`✅ Test 1 PASSED: Cash ride completed as PAID, commission ₹${commissionTx.amount} debited.`);

    // ----------------------------------------------------
    // TEST 2: Unpaid Online ride completion
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing Unpaid ONLINE ride completion...');
    const onlineRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-TEST-UPI-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'UPI',
        paymentStatus: 'PENDING',
        distanceKm: 6.0,
        estimatedFare: 500,
        finalFare: 500,
        pickupLocation: 'Test Pickup Loc',
        pickupAddress: 'Test Pickup Address Online',
        pickupLat: 11.934,
        pickupLng: 79.830,
        dropLocation: 'Test Drop Loc',
        dropAddress: 'Test Drop Address Online',
        dropLat: 11.940,
        dropLng: 79.835,
        startOtp: '1234',
      },
    });
    testRideIds.push(onlineRide.id);

    const preOnlineWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });

    // Complete online ride WITHOUT payment
    const completedOnlineRide = await ridesService.completeRide(onlineRide.id);
    console.log(`Online ride completed. Status: ${completedOnlineRide.status}, PaymentStatus: ${completedOnlineRide.paymentStatus}`);

    if (completedOnlineRide.status !== 'COMPLETED' || completedOnlineRide.paymentStatus !== 'PENDING') {
      throw new Error(`Test 2 Failed: Expected COMPLETED and PENDING (UNPAID), got ${completedOnlineRide.status} and ${completedOnlineRide.paymentStatus}`);
    }

    const postOnlineWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });
    console.log(`Pre wallet: ₹${preOnlineWallet.balance}, Post wallet: ₹${postOnlineWallet.balance}`);

    if (preOnlineWallet.balance !== postOnlineWallet.balance) {
      throw new Error('Test 2 Failed: Driver wallet was modified for an UNPAID online ride! Unreceived funds were credited!');
    }

    const unearnedTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.id,
        referenceRideId: onlineRide.id,
      },
    });
    if (unearnedTx) {
      throw new Error(`Test 2 Failed: Found unexpected wallet transaction for unpaid online ride: ${JSON.stringify(unearnedTx)}`);
    }
    console.log('✅ Test 2 PASSED: Unpaid online ride marked COMPLETED with paymentStatus PENDING. Zero unverified funds credited to driver.');

    // ----------------------------------------------------
    // TEST 3: Online ride switched to cash upon completion
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing Online ride switched to CASH on completion...');
    const switchToCashRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-TEST-SWC-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'CARD',
        paymentStatus: 'PENDING',
        distanceKm: 7.0,
        estimatedFare: 600,
        finalFare: 600,
        pickupLocation: 'Test Pickup Loc',
        pickupAddress: 'Test Pickup Address Switch',
        pickupLat: 11.934,
        pickupLng: 79.830,
        dropLocation: 'Test Drop Loc',
        dropAddress: 'Test Drop Address Switch',
        dropLat: 11.940,
        dropLng: 79.835,
        startOtp: '1234',
      },
    });
    testRideIds.push(switchToCashRide.id);

    const preSwitchWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });

    // Complete with switchToCash: true
    const completedSwitchedRide = await ridesService.completeRide(switchToCashRide.id, { switchToCash: true });
    console.log(`Switched ride completed. Method: ${completedSwitchedRide.paymentMethod}, Status: ${completedSwitchedRide.status}, PaymentStatus: ${completedSwitchedRide.paymentStatus}`);

    if (completedSwitchedRide.paymentMethod !== 'CASH' ||
        completedSwitchedRide.status !== 'COMPLETED' ||
        completedSwitchedRide.paymentStatus !== 'PAID') {
      throw new Error(`Test 3 Failed: Expected CASH, COMPLETED, PAID, got ${completedSwitchedRide.paymentMethod}, ${completedSwitchedRide.status}, ${completedSwitchedRide.paymentStatus}`);
    }

    const postSwitchWallet = await prisma.wallet.findUniqueOrThrow({ where: { driverId: driver.id } });
    console.log(`Pre wallet: ₹${preSwitchWallet.balance}, Post wallet: ₹${postSwitchWallet.balance}`);

    const switchCommissionTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.id,
        referenceRideId: switchToCashRide.id,
        type: 'COMMISSION',
      },
    });
    if (!switchCommissionTx) {
      throw new Error('Test 3 Failed: Expected COMMISSION wallet transaction for switched cash ride!');
    }
    console.log(`✅ Test 3 PASSED: Ride converted to CASH, marked PAID, and commission ₹${switchCommissionTx.amount} debited properly.`);

    console.log('\n🎉 ALL PHASE 1 INTEGRATION TESTS PASSED PERFECTLY!');
  } finally {
    console.log('\nCleaning up test rides and transactions...');
    for (const id of testRideIds) {
      await prisma.walletTransaction.deleteMany({ where: { referenceRideId: id } });
      await prisma.fareBreakdown.deleteMany({ where: { rideId: id } });
      await prisma.ride.deleteMany({ where: { id } });
    }
    console.log('Cleanup completed.');
  }
}

main()
  .catch((e) => {
    console.error('Test Suite Failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
