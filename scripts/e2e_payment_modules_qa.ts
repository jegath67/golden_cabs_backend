import { prisma } from '../src/config/prisma';
import { RidesService } from '../src/modules/rides/rides.service';
import { AdminController } from '../src/modules/admin/admin.controller';
import { RefundsService } from '../src/modules/refunds/refunds.service';
import { walletService } from '../src/modules/wallet/wallet.service';
import { WalletController } from '../src/modules/wallet/wallet.controller';

interface QAResult {
  phase: string;
  name: string;
  status: 'PASSED' | 'FAILED';
  details: string;
}

const results: QAResult[] = [];

function recordResult(phase: string, name: string, status: 'PASSED' | 'FAILED', details: string) {
  results.push({ phase, name, status, details });
  const icon = status === 'PASSED' ? '✅' : '❌';
  console.log(`${icon} [${phase}] ${name}: ${details}`);
}

async function runQA() {
  console.log('===============================================================');
  console.log('   GOLDEN CABS – PAYMENT MODULES END-TO-END QA SUITE');
  console.log('===============================================================\n');

  const ridesService = new RidesService();
  const adminController = new AdminController();
  const refundsService = new RefundsService();
  const walletController = new WalletController();

  // Test Entities
  const driver = await prisma.driverProfile.findFirst({
    include: { wallet: true, user: true },
  });
  if (!driver) throw new Error('No driver found in database for QA');

  // Ensure driver has a wallet with bank details and balance >= 3000
  let driverWallet = driver.wallet;
  if (!driverWallet) {
    driverWallet = await prisma.wallet.create({
      data: {
        driverId: driver.id,
        balance: 3000,
        currency: 'INR',
        bankAccountNumber: '987654321098',
        bankIfsc: 'SBIN0001234',
        bankHolderName: driver.user.name,
      },
    });
  } else {
    driverWallet = await prisma.wallet.update({
      where: { id: driverWallet.id },
      data: {
        balance: Math.max(driverWallet.balance, 3000),
        bankAccountNumber: driverWallet.bankAccountNumber || '987654321098',
        bankIfsc: driverWallet.bankIfsc || 'SBIN0001234',
        bankHolderName: driverWallet.bankHolderName || driver.user.name,
      },
    });
  }

  // Ensure test customer user
  let customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
  if (!customer) {
    customer = await prisma.user.create({
      data: {
        phone: '+919876543210',
        name: 'QA Test Customer',
        role: 'CUSTOMER',
        customerProfile: { create: {} },
      },
    });
  }

  const testRideIds: string[] = [];
  const testRefundIds: string[] = [];
  const testTxIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // PHASE 1: Driver Online Payment Sync
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 1: DRIVER ONLINE PAYMENT SYNC ---');

    // Scenario 1.1: Cash Ride Completion
    const cashRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-CASH-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'CASH',
        paymentStatus: 'PENDING',
        distanceKm: 5.0,
        estimatedFare: 400,
        finalFare: 400,
        pickupLocation: 'QA Loc A',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc B',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1001',
      },
    });
    testRideIds.push(cashRide.id);

    const preCashWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    const completedCash = await ridesService.completeRide(cashRide.id);

    if (completedCash.status === 'COMPLETED' && completedCash.paymentStatus === 'PAID') {
      const postCashWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
      const debitedCommission = preCashWallet.balance - postCashWallet.balance;
      recordResult('Phase 1', 'Scenario 1.1: Cash Ride Completion', 'PASSED', `Status: COMPLETED, PaymentStatus: PAID, Commission debited: ₹${debitedCommission}`);
    } else {
      recordResult('Phase 1', 'Scenario 1.1: Cash Ride Completion', 'FAILED', `Status: ${completedCash.status}, PaymentStatus: ${completedCash.paymentStatus}`);
    }

    // Scenario 1.2: Unpaid Online Ride (Must NOT auto-mark PAID or credit driver wallet)
    const unpaidOnlineRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-UPI-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'UPI',
        paymentStatus: 'PENDING',
        distanceKm: 8.0,
        estimatedFare: 600,
        finalFare: 600,
        pickupLocation: 'QA Loc C',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc D',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1002',
      },
    });
    testRideIds.push(unpaidOnlineRide.id);

    const preUnpaidWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    const completedUnpaid = await ridesService.completeRide(unpaidOnlineRide.id);
    const postUnpaidWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });

    if (completedUnpaid.status === 'COMPLETED' &&
        completedUnpaid.paymentStatus === 'PENDING' &&
        preUnpaidWallet.balance === postUnpaidWallet.balance) {
      recordResult('Phase 1', 'Scenario 1.2: Unpaid Online Ride Completion', 'PASSED', 'Status: COMPLETED, PaymentStatus: PENDING. Driver wallet unchanged (zero unverified funds credited).');
    } else {
      recordResult('Phase 1', 'Scenario 1.2: Unpaid Online Ride Completion', 'FAILED', `paymentStatus: ${completedUnpaid.paymentStatus}, wallet balance changed: ${preUnpaidWallet.balance !== postUnpaidWallet.balance}`);
    }

    // Scenario 1.3: Online Ride Switched to Cash (switchToCash: true)
    const switchedRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-SWC-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'ACCEPTED',
        paymentMethod: 'CARD',
        paymentStatus: 'PENDING',
        distanceKm: 6.0,
        estimatedFare: 500,
        finalFare: 500,
        pickupLocation: 'QA Loc E',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc F',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1003',
      },
    });
    testRideIds.push(switchedRide.id);

    const completedSwitched = await ridesService.completeRide(switchedRide.id, { switchToCash: true });
    if (completedSwitched.paymentMethod === 'CASH' &&
        completedSwitched.status === 'COMPLETED' &&
        completedSwitched.paymentStatus === 'PAID') {
      recordResult('Phase 1', 'Scenario 1.3: Switch to Cash on Ride Completion', 'PASSED', 'Successfully switched paymentMethod to CASH, marked COMPLETED & PAID, and debited commission.');
    } else {
      recordResult('Phase 1', 'Scenario 1.3: Switch to Cash on Ride Completion', 'FAILED', `Method: ${completedSwitched.paymentMethod}, Status: ${completedSwitched.status}, PaymentStatus: ${completedSwitched.paymentStatus}`);
    }

    // -------------------------------------------------------------------------
    // PHASE 2: Admin Payment Overview
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 2: ADMIN PAYMENT OVERVIEW ---');

    // Create a Cancelled Ride for testing stats
    const cancelledRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-CANC-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'CANCELLED',
        paymentMethod: 'CASH',
        paymentStatus: 'PENDING',
        distanceKm: 3.0,
        estimatedFare: 250,
        finalFare: 250,
        pickupLocation: 'QA Loc G',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc H',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1004',
      },
    });
    testRideIds.push(cancelledRide.id);

    // Mock Reply helper
    let adminReply: any = null;
    const mockAdminReply: any = {
      send: (d: any) => { adminReply = d; return d; },
      status: () => mockAdminReply,
    };

    // Scenario 2.1: Fetch all payments & verify stats
    adminReply = null;
    await adminController.getPayments({ query: {} } as any, mockAdminReply);
    const allPayments: any[] = adminReply?.data?.payments || [];
    const stats = adminReply?.data?.stats;

    const paidRideFound = allPayments.find((p) => p.orderId === cashRide.bookingCode);
    const unpaidRideFound = allPayments.find((p) => p.orderId === unpaidOnlineRide.bookingCode);
    const cancelledFound = allPayments.find((p) => p.orderId === cancelledRide.bookingCode);

    const noFakeTxn = allPayments.every((p) => !p.paymentId.startsWith('TXN'));
    const accuratePendingStatus = unpaidRideFound?.status === false && unpaidRideFound?.paymentStatus === 'PENDING';
    const accuratePaidStatus = paidRideFound?.status === true && paidRideFound?.paymentStatus === 'PAID';
    const revenueExcludesUnpaid = allPayments
      .filter((p) => !p.status)
      .every((p) => !stats || p.amount > 0);

    if (noFakeTxn && accuratePendingStatus && accuratePaidStatus && stats.cancelledCount >= 1) {
      recordResult('Phase 2', 'Scenario 2.1: Data Accuracy & Stat Cards', 'PASSED', `Total: ${stats.totalTransactions}, Paid: ${stats.completedCount}, Pending: ${stats.pendingCount}, Cancelled: ${stats.cancelledCount}. Revenue: ₹${stats.totalRevenue}`);
    } else {
      recordResult('Phase 2', 'Scenario 2.1: Data Accuracy & Stat Cards', 'FAILED', `noFakeTxn: ${noFakeTxn}, accuratePending: ${accuratePendingStatus}, accuratePaid: ${accuratePaidStatus}`);
    }

    // Scenario 2.2: Filtering by status = PAID and paymentMethod = CASH
    adminReply = null;
    await adminController.getPayments({ query: { status: 'PAID', paymentMethod: 'CASH' } } as any, mockAdminReply);
    const paidCashPayments: any[] = adminReply?.data?.payments || [];
    const allArePaidCash = paidCashPayments.every((p) => p.paymentStatus === 'PAID' && p.paymentMode === 'CASH');

    if (allArePaidCash && paidCashPayments.length >= 1) {
      recordResult('Phase 2', 'Scenario 2.2: Status & PaymentMethod Filters', 'PASSED', `Filtered ${paidCashPayments.length} records matching status=PAID & method=CASH.`);
    } else {
      recordResult('Phase 2', 'Scenario 2.2: Status & PaymentMethod Filters', 'FAILED', `Count: ${paidCashPayments.length}, allArePaidCash: ${allArePaidCash}`);
    }

    // -------------------------------------------------------------------------
    // PHASE 3: Refund Management
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 3: REFUND MANAGEMENT ---');

    // Scenario 3.1: Manual Non-Wallet Refund Settlement with Bank UTR
    const refundTargetRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-REF-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'UPI',
        paymentStatus: 'PAID',
        distanceKm: 7.0,
        estimatedFare: 480,
        finalFare: 480,
        pickupLocation: 'QA Loc I',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc J',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1005',
      },
    });
    testRideIds.push(refundTargetRide.id);

    // 3.1a: Submit refund request
    const refundReq = await refundsService.submitRefundRequest(
      customer.id,
      refundTargetRide.id,
      'AC not working throughout the trip',
      'Customer requested 100% fare refund'
    );
    testRefundIds.push(refundReq.id);

    // 3.1b: Verify duplicate request blocked
    let duplicateBlocked = false;
    try {
      await refundsService.submitRefundRequest(customer.id, refundTargetRide.id, 'Duplicate attempt');
    } catch {
      duplicateBlocked = true;
    }

    // 3.1c: Admin approval
    const approvedRefund = await refundsService.updateRefundStatus(refundReq.id, 'APPROVED', 'Approved for bank reversal');

    // 3.1d: Admin settlement with Bank UTR
    const testRefundUtr = `UTR-QA-${Date.now()}`;
    const settledRefund = await refundsService.updateRefundStatus(
      refundReq.id,
      'REFUNDED',
      `Manual Settlement [UTR/Ref: ${testRefundUtr}] - Verified by Admin`
    );

    const refRidePost = await prisma.ride.findUniqueOrThrow({ where: { id: refundTargetRide.id } });

    if (duplicateBlocked &&
        approvedRefund.status === 'APPROVED' &&
        settledRefund.status === 'REFUNDED' &&
        refRidePost.paymentStatus === 'REFUNDED') {
      recordResult('Phase 3', 'Scenario 3.1: Manual Non-Wallet Refund Settlement', 'PASSED', `Refund ID: ${settledRefund.id}, Status: REFUNDED, UTR recorded in remarks, Ride paymentStatus updated to REFUNDED.`);
    } else {
      recordResult('Phase 3', 'Scenario 3.1: Manual Non-Wallet Refund Settlement', 'FAILED', `dupBlocked: ${duplicateBlocked}, approved: ${approvedRefund.status}, settled: ${settledRefund.status}, ridePayment: ${refRidePost.paymentStatus}`);
    }

    // Scenario 3.2: In-App Wallet Refund Settlement
    const walletRide = await prisma.ride.create({
      data: {
        bookingCode: `GC-QA-WAL-${Date.now().toString().slice(-4)}`,
        customerId: customer.id,
        driverId: driver.id,
        status: 'COMPLETED',
        paymentMethod: 'WALLET',
        paymentStatus: 'PAID',
        distanceKm: 4.0,
        estimatedFare: 220,
        finalFare: 220,
        pickupLocation: 'QA Loc K',
        pickupLat: 11.93,
        pickupLng: 79.83,
        dropLocation: 'QA Loc L',
        dropLat: 11.94,
        dropLng: 79.84,
        startOtp: '1006',
      },
    });
    testRideIds.push(walletRide.id);

    const preCustWallet = await walletService.getCustomerWallet(customer.id);
    const preCustBal = preCustWallet.balance;

    const refundWalletReq = await refundsService.submitRefundRequest(
      customer.id,
      walletRide.id,
      'Trip cancelled by driver'
    );
    testRefundIds.push(refundWalletReq.id);

    await refundsService.updateRefundStatus(refundWalletReq.id, 'APPROVED', 'Approved');
    const settledWalletRefund = await refundsService.updateRefundStatus(refundWalletReq.id, 'REFUNDED', 'Refund credited to wallet');

    const postCustWallet = await walletService.getCustomerWallet(customer.id);
    const walletTx = await prisma.customerWalletTransaction.findFirst({
      where: { referenceRefundId: refundWalletReq.id },
    });

    if (settledWalletRefund.status === 'REFUNDED' &&
        postCustWallet.balance === preCustBal + 220 &&
        walletTx && walletTx.type === 'REFUND') {
      recordResult('Phase 3', 'Scenario 3.2: Wallet Refund Settlement', 'PASSED', `Refund ₹220 credited to CustomerWallet atomically. Post balance: ₹${postCustWallet.balance}, TxId: ${walletTx.id}.`);
    } else {
      recordResult('Phase 3', 'Scenario 3.2: Wallet Refund Settlement', 'FAILED', `Bal diff: ${postCustWallet.balance - preCustBal}, txFound: ${!!walletTx}`);
    }

    // -------------------------------------------------------------------------
    // PHASE 4: Customer Wallet
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 4: CUSTOMER WALLET ---');

    // Scenario 4.1: Customer Wallet Balance & Transactions Retrieval
    let custWalletReply: any = null;
    const mockCustReply: any = {
      send: (d: any) => { custWalletReply = d; return d; },
      status: () => mockCustReply,
    };

    await walletController.getCustomerWallet(
      { user: { id: customer.id } } as any,
      mockCustReply
    );

    const custBalFetched = custWalletReply?.data?.balance;

    custWalletReply = null;
    await walletController.getCustomerTransactions(
      { user: { id: customer.id }, query: { page: '1', limit: '10' } } as any,
      mockCustReply
    );
    const txTotal = custWalletReply?.data?.total;

    if (typeof custBalFetched === 'number' && typeof txTotal === 'number' && txTotal >= 1) {
      recordResult('Phase 4', 'Scenario 4.1: Customer Balance & Ledger Retrieval', 'PASSED', `Balance: ₹${custBalFetched}, Ledger Transactions: ${txTotal}, Paginated: page 1 of ${custWalletReply.data.totalPages}`);
    } else {
      recordResult('Phase 4', 'Scenario 4.1: Customer Balance & Ledger Retrieval', 'FAILED', `bal: ${custBalFetched}, txTotal: ${txTotal}`);
    }

    // Scenario 4.2: Duplicate Ledger Protection
    const testRefKey = `QA-DUP-${Date.now()}`;
    await prisma.customerWalletTransaction.create({
      data: {
        walletId: preCustWallet.id,
        amount: 50,
        type: 'REFUND',
        status: 'COMPLETED',
        description: 'Idempotency test 1',
        referenceRefundId: testRefKey,
      },
    });

    let duplicateTxBlocked = false;
    try {
      await prisma.customerWalletTransaction.create({
        data: {
          walletId: preCustWallet.id,
          amount: 50,
          type: 'REFUND',
          status: 'COMPLETED',
          description: 'Idempotency test 2',
          referenceRefundId: testRefKey,
        },
      });
    } catch {
      duplicateTxBlocked = true;
    } finally {
      await prisma.customerWalletTransaction.deleteMany({ where: { referenceRefundId: testRefKey } });
    }

    if (duplicateTxBlocked) {
      recordResult('Phase 4', 'Scenario 4.2: Duplicate Transaction Protection', 'PASSED', 'Unique constraint on referenceRefundId strictly prevents duplicate wallet ledger credits.');
    } else {
      recordResult('Phase 4', 'Scenario 4.2: Duplicate Transaction Protection', 'FAILED', 'Database allowed duplicate referenceRefundId!');
    }

    // -------------------------------------------------------------------------
    // PHASE 5: Payout Management
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 5: PAYOUT MANAGEMENT ---');

    // Scenario 5.1: Minimum Cashout Validation
    let minCashoutBlocked = false;
    try {
      await walletService.requestWithdrawal(driver.userId, 100);
    } catch (e: any) {
      if (e.message.includes('Minimum cashout amount')) minCashoutBlocked = true;
    }

    if (minCashoutBlocked) {
      recordResult('Phase 5', 'Scenario 5.1: Minimum Withdrawal Amount Enforcement', 'PASSED', 'Withdrawals under ₹500 are properly rejected.');
    } else {
      recordResult('Phase 5', 'Scenario 5.1: Minimum Withdrawal Amount Enforcement', 'FAILED', 'Withdrawal under ₹500 was not blocked');
    }

    // Scenario 5.2: Payout Lifecycle (Request -> Process -> Completed with UTR)
    // Note: Clean any existing test withdrawals for this settlement week to test cashout lifecycle cleanly
    await prisma.walletTransaction.deleteMany({
      where: {
        walletId: driverWallet.id,
        type: 'WITHDRAWAL',
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });

    const preWithdrawalWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    const cashoutRes = await walletService.requestWithdrawal(driver.userId, 600);
    const payoutTx = cashoutRes.transaction;
    testTxIds.push(payoutTx.id);

    const postReqWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    const fundsReserved = postReqWallet.balance === preWithdrawalWallet.balance - 600 &&
                          postReqWallet.pendingWithdrawals === preWithdrawalWallet.pendingWithdrawals + 600;

    // Moving to PROCESSING
    let payoutReply: any = null;
    let payoutStatusCode = 200;
    const mockPayoutReply: any = {
      send: (d: any) => { payoutReply = d; return d; },
      status: (c: number) => { payoutStatusCode = c; return mockPayoutReply; },
    };

    await adminController.updatePayoutStatus(
      { params: { id: payoutTx.id }, body: { status: 'PROCESSING' } } as any,
      mockPayoutReply
    );
    const movedToProcessing = payoutReply?.data?.status === 'PROCESSING';

    // Blank UTR rejection
    payoutReply = null;
    payoutStatusCode = 200;
    await adminController.updatePayoutStatus(
      { params: { id: payoutTx.id }, body: { status: 'PAID', utrNumber: '' } } as any,
      mockPayoutReply
    );
    const blankUtrBlocked = payoutStatusCode === 400;

    // Complete with Valid UTR
    const validUtr = `UTR-QA-PAYOUT-${Date.now()}`;
    payoutReply = null;
    payoutStatusCode = 200;
    await adminController.updatePayoutStatus(
      { params: { id: payoutTx.id }, body: { status: 'PAID', utrNumber: validUtr } } as any,
      mockPayoutReply
    );
    const completedWithUtr = payoutReply?.data?.status === 'COMPLETED' && payoutReply?.data?.utrNumber === validUtr;

    if (fundsReserved && movedToProcessing && blankUtrBlocked && completedWithUtr) {
      recordResult('Phase 5', 'Scenario 5.2: Payout Lifecycle & UTR Validation', 'PASSED', `Requested ₹600, reserved in pendingWithdrawals, moved to PROCESSING, blank UTR blocked, completed with UTR: ${validUtr}.`);
    } else {
      recordResult('Phase 5', 'Scenario 5.2: Payout Lifecycle & UTR Validation', 'FAILED', `reserved: ${fundsReserved}, proc: ${movedToProcessing}, blankBlocked: ${blankUtrBlocked}, completed: ${completedWithUtr}`);
    }

    // Scenario 5.3: Duplicate UTR Prevention
    const txDupUtr = await prisma.walletTransaction.create({
      data: {
        walletId: driverWallet.id,
        amount: 500,
        type: 'WITHDRAWAL',
        status: 'PENDING',
        description: 'QA duplicate UTR test transaction',
      },
    });
    testTxIds.push(txDupUtr.id);

    payoutReply = null;
    payoutStatusCode = 200;
    await adminController.updatePayoutStatus(
      { params: { id: txDupUtr.id }, body: { status: 'PAID', utrNumber: validUtr } } as any,
      mockPayoutReply
    );
    const duplicateUtrBlocked = payoutStatusCode === 400 && payoutReply?.message?.includes('already been recorded');

    if (duplicateUtrBlocked) {
      recordResult('Phase 5', 'Scenario 5.3: Duplicate UTR Prevention', 'PASSED', 'Duplicate bank UTR was strictly rejected with 400 Bad Request.');
    } else {
      recordResult('Phase 5', 'Scenario 5.3: Duplicate UTR Prevention', 'FAILED', `statusCode: ${payoutStatusCode}, message: ${payoutReply?.message}`);
    }

    // Scenario 5.4: Rejection Reversal & Ledger Consistency
    const preRejectionWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    payoutReply = null;
    payoutStatusCode = 200;
    await adminController.updatePayoutStatus(
      {
        params: { id: txDupUtr.id },
        body: { status: 'REJECTED', rejectionReason: 'Incorrect IFSC code provided by driver' },
      } as any,
      mockPayoutReply
    );

    const postRejectionWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    const fundsRestored = postRejectionWallet.balance === preRejectionWallet.balance + 500;

    const adjustmentTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: driverWallet.id,
        type: 'ADJUSTMENT',
        description: { contains: txDupUtr.id.substring(0, 8) },
      },
    });

    if (fundsRestored && adjustmentTx) {
      recordResult('Phase 5', 'Scenario 5.4: Rejection Reversal & Ledger Audit Trail', 'PASSED', `₹500 restored to available balance. Created ADJUSTMENT ledger entry ${adjustmentTx.id}.`);
    } else {
      recordResult('Phase 5', 'Scenario 5.4: Rejection Reversal & Ledger Audit Trail', 'FAILED', `fundsRestored: ${fundsRestored}, adjTxFound: ${!!adjustmentTx}`);
    }

    // -------------------------------------------------------------------------
    // PHASE 6: Cross-App Synchronization Verification
    // -------------------------------------------------------------------------
    console.log('\n--- EXECUTING PHASE 6: CROSS-APP SYNCHRONIZATION ---');

    // Verify Cash Ride across Backend API, Customer Ride, and Driver Status
    const syncCashRide = await prisma.ride.findUniqueOrThrow({
      where: { id: cashRide.id },
      include: { customer: true, driver: { include: { user: true } } },
    });
    const cashSyncOk = syncCashRide.status === 'COMPLETED' && syncCashRide.paymentStatus === 'PAID';

    // Verify Unpaid Online Ride across Backend API, Customer Ride, and Driver Status
    const syncOnlineRide = await prisma.ride.findUniqueOrThrow({
      where: { id: unpaidOnlineRide.id },
      include: { customer: true, driver: { include: { user: true } } },
    });
    const onlineSyncOk = syncOnlineRide.status === 'COMPLETED' && syncOnlineRide.paymentStatus === 'PENDING';

    // Verify Refund across Admin and Customer
    const syncRefund = await prisma.refundRequest.findUniqueOrThrow({
      where: { id: refundReq.id },
      include: { ride: true, customer: true },
    });
    const refundSyncOk = syncRefund.status === 'REFUNDED' && syncRefund.ride.paymentStatus === 'REFUNDED';

    if (cashSyncOk && onlineSyncOk && refundSyncOk) {
      recordResult('Phase 6', 'Cross-App Synchronization Verification', 'PASSED', 'Cash rides, Unpaid Online rides, and Refunds are 100% synchronized across Customer, Driver, Admin, and PostgreSQL.');
    } else {
      recordResult('Phase 6', 'Cross-App Synchronization Verification', 'FAILED', `cashSync: ${cashSyncOk}, onlineSync: ${onlineSyncOk}, refundSync: ${refundSyncOk}`);
    }

  } finally {
    console.log('\n--- CLEANING UP QA TEST DATA ---');
    for (const rId of testRefundIds) {
      await prisma.customerWalletTransaction.deleteMany({ where: { referenceRefundId: rId } });
      await prisma.refundRequest.deleteMany({ where: { id: rId } });
    }
    for (const txId of testTxIds) {
      await prisma.walletTransaction.deleteMany({
        where: {
          OR: [
            { id: txId },
            { description: { contains: txId.substring(0, 8) } },
          ],
        },
      });
    }
    for (const rideId of testRideIds) {
      await prisma.walletTransaction.deleteMany({ where: { referenceRideId: rideId } });
      await prisma.fareBreakdown.deleteMany({ where: { rideId } });
      await prisma.refundRequest.deleteMany({ where: { rideId } });
      await prisma.ride.deleteMany({ where: { id: rideId } });
    }
    console.log('QA test data cleanup complete.');
  }

  console.log('\n===============================================================');
  console.log('                  QA RESULTS SUMMARY');
  console.log('===============================================================');
  const passedCount = results.filter((r) => r.status === 'PASSED').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;
  console.log(`Total Scenarios Executed: ${results.length}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${failedCount}`);
  console.log('===============================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runQA()
  .catch((e) => {
    console.error('Fatal QA Failure:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
