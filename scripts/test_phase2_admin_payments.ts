import { prisma } from '../src/config/prisma';
import { AdminController } from '../src/modules/admin/admin.controller';

async function main() {
  console.log('--- STARTING PHASE 2 ADMIN PAYMENT OVERVIEW TEST ---');
  const adminController = new AdminController();

  // Find a driver and customer
  const driver = await prisma.driverProfile.findFirst({ include: { user: true } });
  const customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });

  if (!driver || !customer) {
    throw new Error('Test driver or customer missing');
  }

  const testRideIds: string[] = [];

  try {
    // Create 3 distinct test rides:
    // 1. Paid Cash Ride
    const paidRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P2-PAID-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        paymentStatus: 'PAID',
        distanceKm: 5,
        estimatedFare: 300,
        finalFare: 300,
        pickupLocation: 'P2 Loc 1',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P2 Loc 2',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '1111',
      },
    });
    testRideIds.push(paidRide.id);

    // 2. Pending Online Ride (Status COMPLETED, but paymentStatus PENDING)
    const pendingRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P2-PEND-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'UPI',
        paymentStatus: 'PENDING',
        distanceKm: 8,
        estimatedFare: 450,
        finalFare: 450,
        pickupLocation: 'P2 Loc 3',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P2 Loc 4',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '2222',
      },
    });
    testRideIds.push(pendingRide.id);

    // 3. Cancelled Ride
    const cancelledRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-P2-CANC-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'CANCELLED',
        paymentMethod: 'CASH',
        paymentStatus: 'PENDING',
        distanceKm: 3,
        estimatedFare: 200,
        finalFare: 200,
        pickupLocation: 'P2 Loc 5',
        pickupLat: 11.9,
        pickupLng: 79.8,
        dropLocation: 'P2 Loc 6',
        dropLat: 11.95,
        dropLng: 79.85,
        startOtp: '3333',
      },
    });
    testRideIds.push(cancelledRide.id);

    console.log('Created test rides for Paid, Pending, and Cancelled.');

    // Mock Fastify Request & Reply
    let replyData: any = null;
    const mockReply: any = {
      send: (data: any) => {
        replyData = data;
        return replyData;
      },
      status: () => mockReply,
    };

    // Test A: Fetch all payments without filters
    await adminController.getPayments({ query: {} } as any, mockReply);
    if (!replyData?.success || !replyData?.data?.payments) {
      throw new Error('Test A Failed: getPayments did not return expected structure');
    }

    const payments: any[] = replyData.data.payments;
    const stats = replyData.data.stats;
    console.log(`Fetched ${payments.length} total payments. Stats:`, stats);

    // Verify Pending ride has status = false even though ride status is COMPLETED
    const foundPending = payments.find((p) => p.orderId === pendingRide.bookingCode);
    if (!foundPending) throw new Error('Pending ride not found in getPayments response');
    if (foundPending.status !== false || foundPending.paymentStatus !== 'PENDING') {
      throw new Error(`Test A Failed: Pending ride incorrectly marked as paid! Status: ${foundPending.status}, PaymentStatus: ${foundPending.paymentStatus}`);
    }
    console.log('✅ Verified: Online ride with COMPLETED ride status and PENDING paymentStatus correctly has status: false.');

    // Verify Paid ride has status = true
    const foundPaid = payments.find((p) => p.orderId === paidRide.bookingCode);
    if (!foundPaid || foundPaid.status !== true || foundPaid.paymentStatus !== 'PAID') {
      throw new Error('Test A Failed: Paid ride did not have status: true');
    }
    console.log('✅ Verified: Paid ride has status: true.');

    // Verify paymentId does not have fake TXN prefix
    if (foundPaid.paymentId.startsWith('TXN') || foundPending.paymentId.startsWith('TXN')) {
      throw new Error(`Test A Failed: Synthetic TXN prefix still used: ${foundPaid.paymentId}`);
    }
    console.log(`✅ Verified: Internal reference used instead of fake gateway TXN: ${foundPaid.paymentId}`);

    // Verify stats accuracy
    if (stats.cancelledCount < 1) {
      throw new Error(`Test A Failed: cancelledCount in stats is ${stats.cancelledCount}, expected >= 1`);
    }
    console.log(`✅ Verified: Cancelled count accurately calculated (${stats.cancelledCount}).`);

    // Test B: Filter by status = PENDING
    replyData = null;
    await adminController.getPayments({ query: { status: 'PENDING' } } as any, mockReply);
    const pendingFiltered: any[] = replyData.data.payments;
    const hasOnlyPending = pendingFiltered.every((p) => p.paymentStatus === 'PENDING');
    if (!hasOnlyPending) {
      throw new Error('Test B Failed: Filter status=PENDING returned non-pending payments');
    }
    console.log(`✅ Verified: Filter status=PENDING successfully filtered ${pendingFiltered.length} records.`);

    // Test C: Filter by paymentMethod = CASH
    replyData = null;
    await adminController.getPayments({ query: { paymentMethod: 'CASH' } } as any, mockReply);
    const cashFiltered: any[] = replyData.data.payments;
    const hasOnlyCash = cashFiltered.every((p) => p.paymentMode === 'CASH');
    if (!hasOnlyCash) {
      throw new Error('Test C Failed: Filter paymentMethod=CASH returned non-cash payments');
    }
    console.log(`✅ Verified: Filter paymentMethod=CASH successfully filtered ${cashFiltered.length} records.`);

    console.log('\n🎉 ALL PHASE 2 ADMIN PAYMENT OVERVIEW TESTS PASSED PERFECTLY!');
  } finally {
    console.log('\nCleaning up test rides...');
    for (const id of testRideIds) {
      await prisma.ride.deleteMany({ where: { id } });
    }
    console.log('Cleanup complete.');
  }
}

main()
  .catch((e) => {
    console.error('Phase 2 Test Suite Failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
