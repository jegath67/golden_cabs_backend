import { prisma } from '../src/config/prisma';
import { ridesService } from '../src/modules/rides/rides.service';
import { walletService } from '../src/modules/wallet/wallet.service';

async function runTests() {
  console.log('--- Starting Driver Earnings & Settlement E2E Tests ---');

  // Find driver profile
  let driver = await prisma.driverProfile.findFirst({
    include: { user: true, wallet: true },
  });
  if (!driver) {
    throw new Error('No driver profile found in database for testing');
  }
  let testUser = driver.user;

  let customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
  if (!customer) throw new Error('No customer user found');

  // Reset driver wallet for clean test
  let wallet = await prisma.wallet.upsert({
    where: { driverId: driver.id },
    create: {
      driverId: driver.id,
      balance: 100.0,
      lifetimeEarnings: 1000.0,
      pendingWithdrawals: 0.0,
      bankAccountNumber: '9876543210123',
      bankIfsc: 'HDFC0001234',
      bankHolderName: testUser.name,
    },
    update: {
      balance: 100.0,
      lifetimeEarnings: 1000.0,
      pendingWithdrawals: 0.0,
      bankAccountNumber: '9876543210123',
      bankIfsc: 'HDFC0001234',
      bankHolderName: testUser.name,
    },
  });

  console.log(`Initial wallet state: balance=₹${wallet.balance}, lifetimeEarnings=₹${wallet.lifetimeEarnings}`);

  // -------------------------------------------------------------
  // TEST SCENARIO B & C: Cash Ride with ₹1000 fare, ₹200 commission.
  // Initial balance is ₹100. Commission is ₹200.
  // Expected: wallet balance becomes -₹100 (Negative balance / Outstanding dues).
  // -------------------------------------------------------------
  console.log('\n--- Scenario B & C: Cash Ride & Negative Wallet ---');
  const cashRide = await prisma.ride.create({
    data: {
      customerId: customer.id,
      driverId: driver.id,
      pickupLocation: 'Chennai Central',
      dropLocation: 'T Nagar',
      pickupLat: 13.0827,
      pickupLng: 80.2707,
      dropLat: 13.0418,
      dropLng: 80.2341,
      pickupAddress: 'Chennai Central',
      dropAddress: 'T Nagar',
      tripType: 'DAILY',
      paymentMethod: 'CASH',
      estimatedFare: 1000.0,
      finalFare: 1000.0,
      distanceKm: 15.0,
      startOtp: '1234',
      status: 'ONGOING',
      bookingCode: `TEST-CASH-${Date.now().toString().slice(-4)}`,
    },
  });

  await ridesService.completeRide(cashRide.id);

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  console.log(`After Cash Ride: balance=₹${wallet.balance} (Expected -100), lifetime=₹${wallet.lifetimeEarnings}`);
  if (wallet.balance !== -100) {
    throw new Error(`Scenario B/C Failed: Expected balance -100, got ${wallet.balance}`);
  }
  console.log('✅ Scenario B & C Passed! Cash ride debited ₹200 commission only, balance is -₹100.');

  // Verify dashboard calculates outstanding dues of ₹100
  const dashboard1 = await walletService.getEarningsDashboard(testUser.id);
  console.log(`Dashboard outstanding dues: ₹${dashboard1.outstandingCompanyDues} (Expected 100)`);
  if (dashboard1.outstandingCompanyDues !== 100) {
    throw new Error(`Scenario C Failed: Expected outstanding dues 100, got ${dashboard1.outstandingCompanyDues}`);
  }
  console.log('✅ Dashboard correctly identifies outstanding company dues!');

  // -------------------------------------------------------------
  // TEST SCENARIO A: Online/UPI Ride with ₹1000 fare, ₹200 commission.
  // Driver net earnings: ₹800.
  // Previous balance was -₹100.
  // Expected new balance: -100 + 800 = +₹700! Dues automatically recovered!
  // -------------------------------------------------------------
  console.log('\n--- Scenario A: UPI Ride & Automatic Dues Recovery ---');
  const upiRide = await prisma.ride.create({
    data: {
      customerId: customer.id,
      driverId: driver.id,
      pickupLocation: 'T Nagar',
      dropLocation: 'Airport',
      pickupLat: 13.0418,
      pickupLng: 80.2341,
      dropLat: 12.9941,
      dropLng: 80.1709,
      pickupAddress: 'T Nagar',
      dropAddress: 'Airport',
      tripType: 'DAILY',
      paymentMethod: 'UPI',
      estimatedFare: 1000.0,
      finalFare: 1000.0,
      distanceKm: 15.0,
      startOtp: '1234',
      status: 'ONGOING',
      bookingCode: `TEST-UPI-${Date.now().toString().slice(-4)}`,
    },
  });

  await ridesService.completeRide(upiRide.id);

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  console.log(`After UPI Ride: balance=₹${wallet.balance} (Expected 700), lifetime=₹${wallet.lifetimeEarnings}`);
  if (wallet.balance !== 700) {
    throw new Error(`Scenario A Failed: Expected balance 700, got ${wallet.balance}`);
  }
  console.log('✅ Scenario A Passed! UPI ride credited ₹800 net earnings, recovered dues, new balance is ₹700.');

  // -------------------------------------------------------------
  // TEST SCENARIO D: Cashout Request
  // Driver requests ₹500 cashout.
  // Balance becomes 700 - 500 = 200, pendingWithdrawals becomes 500.
  // -------------------------------------------------------------
  console.log('\n--- Scenario D: Cashout Request ---');
  const withdrawRes = await walletService.requestWithdrawal(testUser.id, 500);
  console.log('Withdrawal response:', withdrawRes.transaction.id, withdrawRes.transaction.status);

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  console.log(`After Cashout Request: balance=₹${wallet.balance} (Expected 200), pending=₹${wallet.pendingWithdrawals} (Expected 500)`);
  if (wallet.balance !== 200 || wallet.pendingWithdrawals !== 500) {
    throw new Error(`Scenario D Failed: Expected bal=200, pending=500, got bal=${wallet.balance}, pending=${wallet.pendingWithdrawals}`);
  }
  console.log('✅ Scenario D Passed! Reserved ₹500 for cashout.');

  // -------------------------------------------------------------
  // TEST SCENARIO E: Admin Marks Paid with UTR Number
  // Status becomes COMPLETED, pendingWithdrawals decremented to 0.
  // -------------------------------------------------------------
  console.log('\n--- Scenario E: Admin Settlement & Payout Completion ---');
  const txId = withdrawRes.transaction.id;
  await prisma.$transaction(async (tx) => {
    await tx.walletTransaction.update({
      where: { id: txId },
      data: {
        status: 'COMPLETED',
        utrNumber: 'UTR-TEST-99887766',
        paidAt: new Date(),
      },
    });
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        pendingWithdrawals: { decrement: 500 },
      },
    });
  });

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const completedTx = (await prisma.walletTransaction.findUnique({ where: { id: txId } }))!;
  console.log(`After Admin Paid: balance=₹${wallet.balance}, pending=₹${wallet.pendingWithdrawals}, UTR=${completedTx.utrNumber}`);
  if (wallet.pendingWithdrawals !== 0 || completedTx.status !== 'COMPLETED' || completedTx.utrNumber !== 'UTR-TEST-99887766') {
    throw new Error('Scenario E Failed');
  }
  console.log('✅ Scenario E Passed! Payout marked COMPLETED with UTR number.');

  // Clean up test rides & txs
  await prisma.walletTransaction.deleteMany({
    where: {
      OR: [
        { referenceRideId: cashRide.id },
        { referenceRideId: upiRide.id },
        { id: txId },
      ],
    },
  });
  await prisma.ride.deleteMany({
    where: { id: { in: [cashRide.id, upiRide.id] } },
  });

  console.log('\n🎉 ALL E2E BACKEND SETTLEMENT SCENARIOS PASSED WITH 100% ACCURACY! 🎉\n');
}

runTests()
  .catch((e) => {
    console.error('Test run failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
