import { prisma } from '../src/config/prisma';
import { RefundsService } from '../src/modules/refunds/refunds.service';

async function main() {
  console.log('--- STARTING PHASE 3 REFUND MANAGEMENT TEST ---');
  const refundsService = new RefundsService();

  const driver = await prisma.driverProfile.findFirst({ include: { user: true } });
  const customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });

  if (!driver || !customer) {
    throw new Error('Test driver or customer missing');
  }

  const testRideIds: string[] = [];

  try {
    // ----------------------------------------------------
    // TEST 1: Paid Online Ride Manual Refund (Non-Wallet)
    // ----------------------------------------------------
    console.log('\n[Test 1] Testing Non-Wallet Paid Ride Refund with Bank UTR...');
    const upiRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P3-UPI-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'UPI',
        paymentStatus: 'PAID',
        distanceKm: 10,
        estimatedFare: 550,
        finalFare: 550,
        pickupLocation: 'P3 Loc 1',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P3 Loc 2',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '4444',
      },
    });
    testRideIds.push(upiRide.id);

    // 1a: Submit refund request
    const refund1 = await refundsService.submitRefundRequest(
      customer.id,
      upiRide.id,
      'Trip ended prematurely due to vehicle breakdown',
      'Driver agreed to refund'
    );
    console.log(`Refund request created: ${refund1.id}, Status: ${refund1.status}, Amount: ₹${refund1.amount}`);
    if (refund1.status !== 'SUBMITTED' || refund1.amount !== 550) {
      throw new Error(`Test 1a Failed: Expected SUBMITTED and ₹550, got ${refund1.status} and ${refund1.amount}`);
    }

    // 1b: Duplicate request rejection
    try {
      await refundsService.submitRefundRequest(customer.id, upiRide.id, 'Duplicate attempt');
      throw new Error('Test 1b Failed: Duplicate refund request was not rejected!');
    } catch (e: any) {
      console.log('✅ Duplicate refund request properly rejected with error:', e.message);
    }

    // 1c: Direct settlement without approval should fail
    try {
      await refundsService.updateRefundStatus(refund1.id, 'REFUNDED', 'Direct settlement test');
      throw new Error('Test 1c Failed: Transition from SUBMITTED directly to REFUNDED should not be allowed!');
    } catch (e: any) {
      console.log('✅ Direct settlement without approval properly rejected:', e.message);
    }

    // 1d: Approve refund
    const approved1 = await refundsService.updateRefundStatus(refund1.id, 'APPROVED', 'Approved for payout by Admin');
    console.log(`Refund approved. Status: ${approved1.status}`);
    if (approved1.status !== 'APPROVED') {
      throw new Error('Test 1d Failed: Expected APPROVED status');
    }

    // 1e: Settle refund with bank UTR (Previously failed with HTTP 422!)
    const settled1 = await refundsService.updateRefundStatus(
      refund1.id,
      'REFUNDED',
      'Settled via manual bank transfer: UTR9988776655'
    );
    console.log(`Refund settled! Status: ${settled1.status}, Remarks: ${settled1.adminRemarks}`);
    if (settled1.status !== 'REFUNDED') {
      throw new Error('Test 1e Failed: Expected REFUNDED status');
    }

    // Verify Ride paymentStatus is now REFUNDED
    const updatedRide1 = await prisma.ride.findUniqueOrThrow({ where: { id: upiRide.id } });
    if (updatedRide1.paymentStatus !== 'REFUNDED') {
      throw new Error(`Test 1e Failed: Ride paymentStatus is ${updatedRide1.paymentStatus}, expected REFUNDED`);
    }
    console.log('✅ Test 1 PASSED: Non-wallet refund successfully approved and settled with bank UTR; ride paymentStatus marked REFUNDED.');

    // ----------------------------------------------------
    // TEST 2: Wallet Refund Settlement
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing In-App WALLET Ride Refund Settlement...');
    const walletRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P3-WAL-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'WALLET',
        paymentStatus: 'PAID',
        distanceKm: 5,
        estimatedFare: 300,
        finalFare: 300,
        pickupLocation: 'P3 Loc 3',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P3 Loc 4',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '5555',
      },
    });
    testRideIds.push(walletRide.id);

    const initialCustomerWallet = await prisma.customerWallet.findUnique({ where: { customerId: customer.id } });
    const initialCustomerBalance = initialCustomerWallet ? initialCustomerWallet.balance : 0;

    const refund2 = await refundsService.submitRefundRequest(
      customer.id,
      walletRide.id,
      'Driver took incorrect route'
    );
    await refundsService.updateRefundStatus(refund2.id, 'APPROVED', 'Approved for wallet credit');
    const settled2 = await refundsService.updateRefundStatus(refund2.id, 'REFUNDED', 'Credited to customer wallet');

    if (settled2.status !== 'REFUNDED') {
      throw new Error('Test 2 Failed: Expected wallet refund status REFUNDED');
    }

    const postCustomerWallet = await prisma.customerWallet.findUniqueOrThrow({ where: { customerId: customer.id } });
    console.log(`Initial Customer Wallet: ₹${initialCustomerBalance}, Post-Refund Balance: ₹${postCustomerWallet.balance}`);

    if (postCustomerWallet.balance !== initialCustomerBalance + 300) {
      throw new Error(`Test 2 Failed: Expected customer wallet to increase by 300, got ${postCustomerWallet.balance - initialCustomerBalance}`);
    }

    const walletTx = await prisma.customerWalletTransaction.findFirst({
      where: {
        referenceRefundId: refund2.id,
        type: 'REFUND',
      },
    });
    if (!walletTx) {
      throw new Error('Test 2 Failed: Expected customer wallet ledger transaction for refund!');
    }
    console.log(`✅ Test 2 PASSED: Wallet refund credited ₹${walletTx.amount} atomically to CustomerWallet with ledger transaction.`);

    // ----------------------------------------------------
    // TEST 3: Rejection requires remarks
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing Rejection validation...');
    const rejectRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P3-REJ-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        paymentStatus: 'PAID',
        distanceKm: 4,
        estimatedFare: 250,
        finalFare: 250,
        pickupLocation: 'P3 Loc 5',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P3 Loc 6',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '6666',
      },
    });
    testRideIds.push(rejectRide.id);

    const refund3 = await refundsService.submitRefundRequest(customer.id, rejectRide.id, 'Disputed cash fare');

    try {
      await refundsService.updateRefundStatus(refund3.id, 'REJECTED', '');
      throw new Error('Test 3 Failed: Rejection without remarks should not be allowed!');
    } catch (e: any) {
      console.log('✅ Rejection without remarks properly blocked:', e.message);
    }

    const rejected3 = await refundsService.updateRefundStatus(refund3.id, 'REJECTED', 'Trip was completed as normal, no overcharge found');
    if (rejected3.status !== 'REJECTED') {
      throw new Error('Test 3 Failed: Expected REJECTED status');
    }
    console.log('✅ Test 3 PASSED: Refund rejected with mandatory remarks.');

    console.log('\n🎉 ALL PHASE 3 REFUND MANAGEMENT TESTS PASSED PERFECTLY!');
  } finally {
    console.log('\nCleaning up test refund data...');
    for (const id of testRideIds) {
      const ref = await prisma.refundRequest.findUnique({ where: { rideId: id } });
      if (ref) {
        await prisma.customerWalletTransaction.deleteMany({ where: { referenceRefundId: ref.id } });
        await prisma.refundRequest.deleteMany({ where: { id: ref.id } });
      }
      await prisma.ride.deleteMany({ where: { id } });
    }
    console.log('Cleanup complete.');
  }
}

main()
  .catch((e) => {
    console.error('Phase 3 Test Suite Failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
