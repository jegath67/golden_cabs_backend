import { prisma } from '../src/config/prisma';
import { platformSettingsService } from '../src/modules/settings/platform-settings.service';
import { ridesService } from '../src/modules/rides/rides.service';
import { walletService } from '../src/modules/wallet/wallet.service';

const BASE_URL = 'http://localhost:3000';

interface AuditScenarioResult {
  id: number;
  scenario: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}

const auditResults: AuditScenarioResult[] = [];

async function makeRequest(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ statusCode: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let resBody: any;
  const text = await res.text();
  try {
    resBody = JSON.parse(text);
  } catch {
    resBody = text;
  }

  return { statusCode: res.status, body: resBody };
}

async function runAuditSuite() {
  console.log('========================================================================');
  console.log('  GOLDEN CABS - DRIVER EARNINGS, WALLET & CASHOUT E2E AUDIT SUITE');
  console.log('========================================================================\n');

  // 1. Authenticate Admin
  console.log('🔑 Authenticating Admin...');
  const adminLoginRes = await makeRequest('POST', '/api/auth/admin-login', {
    identifier: 'admin@goldencabs.com',
    password: 'admin123',
  });
  if (adminLoginRes.statusCode !== 200 || !adminLoginRes.body?.data?.token) {
    throw new Error(`Admin login failed: ${JSON.stringify(adminLoginRes.body)}`);
  }
  const adminToken = adminLoginRes.body.data.token;
  console.log('✅ Admin authenticated successfully.\n');

  // 2. Setup Dedicated Test Driver and Customer
  console.log('👤 Setting up Test Driver & Customer...');
  const testPhone = '9876540001';
  let testUser = await prisma.user.findUnique({ where: { phone: testPhone } });
  if (!testUser) {
    testUser = await prisma.user.create({
      data: {
        phone: testPhone,
        name: 'Audit Test Driver',
        email: 'audit_driver@goldencabs.com',
        role: 'DRIVER',
        isActive: true,
      },
    });
  }

  let driverProfile = await prisma.driverProfile.findUnique({ where: { userId: testUser.id } });
  if (!driverProfile) {
    driverProfile = await prisma.driverProfile.create({
      data: {
        userId: testUser.id,
        approvalStatus: 'APPROVED',
        isOnline: true,
      },
    });
  }

  const custPhone = '9876540002';
  let custUser = await prisma.user.findUnique({ where: { phone: custPhone } });
  if (!custUser) {
    custUser = await prisma.user.create({
      data: {
        phone: custPhone,
        name: 'Audit Test Customer',
        email: 'audit_customer@goldencabs.com',
        role: 'CUSTOMER',
        isActive: true,
      },
    });
  }

  // Get Driver Token via OTP
  await makeRequest('POST', '/api/auth/send-otp', { phone: testPhone, intent: 'LOGIN' });
  const driverVerifyRes = await makeRequest('POST', '/api/auth/verify-otp', {
    phone: testPhone,
    otp: '123456',
    role: 'DRIVER',
  });
  const driverToken = driverVerifyRes.body?.data?.token;
  if (!driverToken) {
    throw new Error(`Driver OTP verification failed: ${JSON.stringify(driverVerifyRes.body)}`);
  }
  console.log('✅ Driver authenticated successfully via JWT.\n');

  // Reset Driver Wallet & Clear past test transactions for a deterministic run
  let wallet = await prisma.wallet.upsert({
    where: { driverId: driverProfile.id },
    create: {
      driverId: driverProfile.id,
      balance: 0.0,
      lifetimeEarnings: 0.0,
      pendingWithdrawals: 0.0,
      bankAccountNumber: '9876543210123',
      bankIfsc: 'HDFC0001234',
      bankHolderName: 'Audit Test Driver',
    },
    update: {
      balance: 0.0,
      lifetimeEarnings: 0.0,
      pendingWithdrawals: 0.0,
      bankAccountNumber: '9876543210123',
      bankIfsc: 'HDFC0001234',
      bankHolderName: 'Audit Test Driver',
    },
  });

  await prisma.walletTransaction.deleteMany({
    where: { walletId: wallet.id },
  });

  // Ensure initial commission is 20%
  await platformSettingsService.setCommissionPercent(20);

  // ------------------------------------------------------------------------
  // SCENARIO 1: Customer Cash Payment Ride & Outstanding Dues
  // ------------------------------------------------------------------------
  console.log('--- [1/10] Testing Customer Cash Payment Ride ---');
  const cashRide = await prisma.ride.create({
    data: {
      customerId: custUser.id,
      driverId: driverProfile.id,
      pickupLocation: 'Chennai Airport',
      dropLocation: 'T Nagar',
      pickupAddress: 'Chennai Airport',
      dropAddress: 'T Nagar',
      pickupLat: 12.9941,
      pickupLng: 80.1709,
      dropLat: 13.0418,
      dropLng: 80.2341,
      tripType: 'DAILY',
      paymentMethod: 'CASH',
      estimatedFare: 1000.0,
      finalFare: 1000.0,
      distanceKm: 15.0,
      startOtp: '1234',
      status: 'ONGOING',
      bookingCode: `AUDIT-CASH-${Date.now().toString().slice(-4)}`,
    },
  });

  await ridesService.completeRide(cashRide.id);

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const cashTx = await prisma.walletTransaction.findFirst({
    where: { walletId: wallet.id, referenceRideId: cashRide.id },
  });
  const dash1Res = await makeRequest('GET', '/api/wallet/dashboard', undefined, driverToken);

  const sc1Pass =
    wallet.balance === -200 &&
    cashTx?.type === 'COMMISSION' &&
    cashTx?.amount === 200 &&
    dash1Res.body?.data?.outstandingCompanyDues === 200 &&
    dash1Res.body?.data?.availableCashoutBalance === 0;

  auditResults.push({
    id: 1,
    scenario: 'Customer Cash Payment Settlement',
    expected: 'Driver collects ₹1000 in hand; debits ₹200 commission; balance becomes -₹200 dues; available cashout is ₹0',
    actual: `Balance: ₹${wallet.balance}, Dues: ₹${dash1Res.body?.data?.outstandingCompanyDues}, Available: ₹${dash1Res.body?.data?.availableCashoutBalance}`,
    status: sc1Pass ? 'PASS' : 'FAIL',
    evidence: `Tx ID: ${cashTx?.id}, Type: ${cashTx?.type}, Commission: ₹${cashTx?.amount}`,
  });
  console.log(`Result: ${sc1Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 2: Customer UPI Payment Ride & Automatic Dues Recovery
  // ------------------------------------------------------------------------
  console.log('--- [2/10] Testing Customer UPI Payment & Dues Recovery ---');
  const upiRide = await prisma.ride.create({
    data: {
      customerId: custUser.id,
      driverId: driverProfile.id,
      pickupLocation: 'T Nagar',
      dropLocation: 'Central Station',
      pickupAddress: 'T Nagar',
      dropAddress: 'Central Station',
      pickupLat: 13.0418,
      pickupLng: 80.2341,
      dropLat: 13.0827,
      dropLng: 80.2707,
      tripType: 'DAILY',
      paymentMethod: 'UPI',
      estimatedFare: 1000.0,
      finalFare: 1000.0,
      distanceKm: 12.0,
      startOtp: '1234',
      status: 'ONGOING',
      bookingCode: `AUDIT-UPI-${Date.now().toString().slice(-4)}`,
    },
  });

  await ridesService.completeRide(upiRide.id);

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const upiTx = await prisma.walletTransaction.findFirst({
    where: { walletId: wallet.id, referenceRideId: upiRide.id },
  });
  const dash2Res = await makeRequest('GET', '/api/wallet/dashboard', undefined, driverToken);

  const sc2Pass =
    wallet.balance === 600 &&
    upiTx?.type === 'EARNING' &&
    upiTx?.amount === 800 &&
    dash2Res.body?.data?.outstandingCompanyDues === 0 &&
    dash2Res.body?.data?.availableCashoutBalance === 600;

  auditResults.push({
    id: 2,
    scenario: 'Customer UPI Payment & Dues Recovery',
    expected: 'Company receives ₹1000; credits ₹800 net earnings; previous -₹200 recovered; balance is ₹600; dues is ₹0',
    actual: `Balance: ₹${wallet.balance}, Net Earning: ₹${upiTx?.amount}, Outstanding Dues: ₹${dash2Res.body?.data?.outstandingCompanyDues}`,
    status: sc2Pass ? 'PASS' : 'FAIL',
    evidence: `Tx ID: ${upiTx?.id}, New Balance: ₹${wallet.balance}, Dues Cleared: Yes`,
  });
  console.log(`Result: ${sc2Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 3: Ride Settlement Idempotency (Prevent Double Credit)
  // ------------------------------------------------------------------------
  console.log('--- [3/10] Testing Ride Settlement Idempotency ---');
  const countBefore = await prisma.walletTransaction.count({
    where: { referenceRideId: upiRide.id },
  });
  let duplicateThrew = false;
  try {
    await ridesService.completeRide(upiRide.id); // Attempt duplicate completion
  } catch (err: any) {
    if (err.message?.includes('already completed')) {
      duplicateThrew = true;
    }
  }
  const countAfter = await prisma.walletTransaction.count({
    where: { referenceRideId: upiRide.id },
  });
  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;

  const sc3Pass = duplicateThrew && countBefore === 1 && countAfter === 1 && wallet.balance === 600;
  auditResults.push({
    id: 3,
    scenario: 'Ride Settlement Idempotency',
    expected: 'Duplicate ride completion call is blocked; no additional ledger entry or balance credit',
    actual: `Blocked duplicate: ${duplicateThrew}, Tx count before: ${countBefore}, Tx count after: ${countAfter}, Wallet balance: ₹${wallet.balance}`,
    status: sc3Pass ? 'PASS' : 'FAIL',
    evidence: `Reference Ride: ${upiRide.id}, No duplicate transactions created`,
  });
  console.log(`Result: ${sc3Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 4: Cashout Eligibility & Minimum Amount
  // ------------------------------------------------------------------------
  console.log('--- [4/10] Testing Cashout Eligibility & Minimum Validation ---');
  // Attempt ₹300 (< ₹500)
  const belowMinRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 300 },
    driverToken
  );
  // Attempt ₹1500 (> ₹600 available)
  const exceedRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 1500 },
    driverToken
  );

  const sc4Pass =
    belowMinRes.statusCode === 400 &&
    belowMinRes.body?.message?.includes('500') &&
    exceedRes.statusCode === 400 &&
    (exceedRes.body?.message?.includes('exceeds') || exceedRes.body?.message?.includes('Insufficient'));

  auditResults.push({
    id: 4,
    scenario: 'Cashout Eligibility & Minimum Amount Validation',
    expected: 'Rejects ₹300 with min ₹500 requirement; rejects ₹1500 with insufficient/exceeds balance error',
    actual: `₹300 status: ${belowMinRes.statusCode} ("${belowMinRes.body?.message}"), ₹1500 status: ${exceedRes.statusCode} ("${exceedRes.body?.message}")`,
    status: sc4Pass ? 'PASS' : 'FAIL',
    evidence: `Min ₹500 enforced, available balance check strictly honored`,
  });
  console.log(`Result: ${sc4Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 5: Cashout Request & Amount Reservation
  // ------------------------------------------------------------------------
  console.log('--- [5/10] Testing Cashout Request & Amount Reservation ---');
  const validCashoutRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 500 },
    driverToken
  );
  const cashoutTxId = validCashoutRes.body?.data?.transaction?.id;

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const cashoutTx = await prisma.walletTransaction.findUnique({
    where: { id: cashoutTxId },
  });

  const sc5Pass =
    validCashoutRes.statusCode === 200 &&
    wallet.balance === 100 &&
    wallet.pendingWithdrawals === 500 &&
    cashoutTx?.status === 'PENDING';

  auditResults.push({
    id: 5,
    scenario: 'Cashout Request & Amount Reservation',
    expected: 'Driver requests ₹500; balance reduced from ₹600 to ₹100; pendingWithdrawals becomes ₹500; status PENDING',
    actual: `Status code: ${validCashoutRes.statusCode}, Balance: ₹${wallet.balance}, Pending: ₹${wallet.pendingWithdrawals}, Tx Status: ${cashoutTx?.status}`,
    status: sc5Pass ? 'PASS' : 'FAIL',
    evidence: `Tx ID: ${cashoutTxId}, Amount Reserved: ₹500`,
  });
  console.log(`Result: ${sc5Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 6: Concurrent / Duplicate Cashout Guard
  // ------------------------------------------------------------------------
  console.log('--- [6/10] Testing Concurrent / Duplicate Cashout Guard ---');
  // Attempt second withdrawal while first is pending
  const secondCashoutRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 500 },
    driverToken
  );

  const sc6Pass =
    secondCashoutRes.statusCode === 400 &&
    secondCashoutRes.body?.message?.includes('active cashout request in progress');

  auditResults.push({
    id: 6,
    scenario: 'Concurrent / Duplicate Cashout Guard',
    expected: 'Blocks subsequent cashout while active pending cashout exists',
    actual: `Status: ${secondCashoutRes.statusCode}, Error: "${secondCashoutRes.body?.message}"`,
    status: sc6Pass ? 'PASS' : 'FAIL',
    evidence: `Blocked concurrent cashout while Tx ${cashoutTxId} is PENDING`,
  });
  console.log(`Result: ${sc6Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 7: Cashout Rejection & Reserved Amount Release
  // ------------------------------------------------------------------------
  console.log('--- [7/10] Testing Admin Rejection & Reserved Amount Release ---');
  // Attempt reject without reason
  const rejectNoReasonRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${cashoutTxId}/status`,
    { status: 'FAILED' },
    adminToken
  );

  // Reject with valid reason
  const rejectReason = 'Driver bank account number and IFSC mismatch';
  const rejectWithReasonRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${cashoutTxId}/status`,
    { status: 'FAILED', rejectionReason: rejectReason },
    adminToken
  );

  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const rejectedTx = await prisma.walletTransaction.findUnique({
    where: { id: cashoutTxId },
  });
  const reversalTx = await prisma.walletTransaction.findFirst({
    where: { walletId: wallet.id, type: 'ADJUSTMENT', amount: 500 },
  });

  // Test idempotency: Reject again
  const rejectAgainRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${cashoutTxId}/status`,
    { status: 'FAILED', rejectionReason: rejectReason },
    adminToken
  );
  const walletAfterSecondReject = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;

  // Test rejected cannot be marked paid
  const payRejectedRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${cashoutTxId}/status`,
    { status: 'COMPLETED', utrNumber: 'UTR-INVALID-REJECTED' },
    adminToken
  );

  const sc7Pass =
    rejectNoReasonRes.statusCode === 400 &&
    rejectWithReasonRes.statusCode === 200 &&
    wallet.balance === 600 &&
    wallet.pendingWithdrawals === 0 &&
    rejectedTx?.status === 'FAILED' &&
    rejectedTx?.rejectionReason === rejectReason &&
    reversalTx !== null &&
    walletAfterSecondReject.balance === 600 && // Idempotent: no double refund
    payRejectedRes.statusCode === 400; // Cannot pay rejected

  auditResults.push({
    id: 7,
    scenario: 'Cashout Rejection, Release & Idempotency',
    expected: 'Rejection requires reason; releases ₹500 back to balance; pending becomes 0; logs ADJUSTMENT; idempotent (no double credit); cannot be paid later',
    actual: `No reason status: ${rejectNoReasonRes.statusCode}, Release balance: ₹${wallet.balance}, Pending: ₹${wallet.pendingWithdrawals}, Idempotent balance: ₹${walletAfterSecondReject.balance}, Pay rejected status: ${payRejectedRes.statusCode}`,
    status: sc7Pass ? 'PASS' : 'FAIL',
    evidence: `Reversal Tx: ${reversalTx?.id}, Rejection Reason: "${rejectedTx?.rejectionReason}"`,
  });
  console.log(`Result: ${sc7Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 8: Weekly Quota Enforcement (1 Paid Cashout per Week)
  // ------------------------------------------------------------------------
  console.log('--- [8/10] Testing Weekly Cashout Quota Enforcement ---');
  // Since previous was FAILED, driver should be eligible to request again!
  const eligibleAfterRejectRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 500 },
    driverToken
  );
  const cashout2TxId = eligibleAfterRejectRes.body?.data?.transaction?.id;

  // Admin marks this second cashout as COMPLETED with UTR
  const markPaidRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${cashout2TxId}/status`,
    { status: 'COMPLETED', utrNumber: 'UTR-WEEKLY-TEST-001' },
    adminToken
  );

  // Now attempt a third cashout in the same week
  // Add funds via legitimate adjustment so driver has enough balance
  await prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: 1000 } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: 1000,
        type: 'ADJUSTMENT',
        status: 'COMPLETED',
        description: 'Audit test ledger credit',
      },
    });
  });

  const weeklyBlockedRes = await makeRequest(
    'POST',
    '/api/wallet/withdraw',
    { amount: 500 },
    driverToken
  );

  const sc8Pass =
    eligibleAfterRejectRes.statusCode === 200 &&
    markPaidRes.statusCode === 200 &&
    weeklyBlockedRes.statusCode === 400 &&
    weeklyBlockedRes.body?.message?.includes('Weekly cashout limit reached');

  auditResults.push({
    id: 8,
    scenario: 'Weekly Cashout Quota Enforcement',
    expected: 'Rejected cashout does not block re-request; once a cashout is COMPLETED, subsequent requests in the same week are blocked',
    actual: `Request after reject status: ${eligibleAfterRejectRes.statusCode}, Mark paid status: ${markPaidRes.statusCode}, Same-week request status: ${weeklyBlockedRes.statusCode} ("${weeklyBlockedRes.body?.message}")`,
    status: sc8Pass ? 'PASS' : 'FAIL',
    evidence: `1 completed payout allowed per settlement week (Mon 00:00 - Sun 23:59)`,
  });
  console.log(`Result: ${sc8Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 9: Admin-Configurable Commission
  // ------------------------------------------------------------------------
  console.log('--- [9/10] Testing Admin-Configurable Commission ---');
  // Verify persistent storage & live get
  const getCommRes = await makeRequest('GET', '/api/admin/settings/commission', undefined, adminToken);
  const initialComm = getCommRes.body?.data?.commissionPercent;

  // Test invalid bounds (-5, 60, NaN)
  const invalidCommRes1 = await makeRequest(
    'PATCH',
    '/api/admin/settings/commission',
    { commissionPercent: -5 },
    adminToken
  );
  const invalidCommRes2 = await makeRequest(
    'PATCH',
    '/api/admin/settings/commission',
    { commissionPercent: 60 },
    adminToken
  );

  // Update commission to 15%
  const updateCommRes = await makeRequest(
    'PATCH',
    '/api/admin/settings/commission',
    { commissionPercent: 15 },
    adminToken
  );

  // Complete a new Cash ride at 15% commission
  const cashRide15 = await prisma.ride.create({
    data: {
      customerId: custUser.id,
      driverId: driverProfile.id,
      pickupLocation: 'Guindy',
      dropLocation: 'Velachery',
      pickupAddress: 'Guindy',
      dropAddress: 'Velachery',
      pickupLat: 13.0067,
      pickupLng: 80.2025,
      dropLat: 12.9759,
      dropLng: 80.2212,
      tripType: 'DAILY',
      paymentMethod: 'CASH',
      estimatedFare: 1000.0,
      finalFare: 1000.0,
      distanceKm: 8.0,
      startOtp: '1234',
      status: 'ONGOING',
      bookingCode: `AUDIT-15-CASH-${Date.now().toString().slice(-4)}`,
    },
  });
  await ridesService.completeRide(cashRide15.id);
  const tx15Cash = await prisma.walletTransaction.findFirst({
    where: { referenceRideId: cashRide15.id },
  });

  // Verify historical ride at 20% remains untouched
  const histTx = await prisma.walletTransaction.findFirst({
    where: { referenceRideId: cashRide.id },
  });

  // Restore commission back to 20%
  await makeRequest(
    'PATCH',
    '/api/admin/settings/commission',
    { commissionPercent: 20 },
    adminToken
  );

  const sc9Pass =
    initialComm === 20 &&
    invalidCommRes1.statusCode === 400 &&
    invalidCommRes2.statusCode === 400 &&
    updateCommRes.statusCode === 200 &&
    tx15Cash?.amount === 150 && // 15% of ₹1000
    histTx?.amount === 200; // Historical 20% preserved!

  auditResults.push({
    id: 9,
    scenario: 'Admin-Configurable Commission & Dynamic Application',
    expected: 'Commission stored in DB; invalid values (<0, >50) rejected; updated to 15% applies to new rides; historical 20% records unaffected',
    actual: `Initial: ${initialComm}%, Invalid status: ${invalidCommRes1.statusCode}/${invalidCommRes2.statusCode}, New 15% commission: ₹${tx15Cash?.amount}, Historical 20% commission: ₹${histTx?.amount}`,
    status: sc9Pass ? 'PASS' : 'FAIL',
    evidence: `PlatformSetting key: PLATFORM_COMMISSION_PERCENT, Historical records strictly immutable`,
  });
  console.log(`Result: ${sc9Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // SCENARIO 10: Bank Payout & UTR Verification
  // ------------------------------------------------------------------------
  console.log('--- [10/10] Testing Bank Payout & UTR Verification ---');
  // Create a pending cashout directly in DB to test Admin payout validations
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: { decrement: 600 },
      pendingWithdrawals: { increment: 600 },
    },
  });
  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;

  const payoutToVerify = await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      amount: 600,
      type: 'WITHDRAWAL',
      status: 'PENDING',
      description: 'Cashout request for UTR audit',
      previousBalance: wallet.balance + 600,
      newBalance: wallet.balance,
    },
  });

  // Test empty/missing UTR
  const emptyUtrRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${payoutToVerify.id}/status`,
    { status: 'COMPLETED', utrNumber: '   ' },
    adminToken
  );

  // Test duplicate UTR (using UTR-WEEKLY-TEST-001 from Scenario 8)
  const dupUtrRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${payoutToVerify.id}/status`,
    { status: 'COMPLETED', utrNumber: 'UTR-WEEKLY-TEST-001' },
    adminToken
  );

  // Mark paid with valid UTR
  const validUtr = `UTR-AUDIT-FINAL-${Date.now().toString().slice(-6)}`;
  const validPayRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${payoutToVerify.id}/status`,
    { status: 'COMPLETED', utrNumber: validUtr },
    adminToken
  );

  // Attempt to mark paid again
  const payAgainRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${payoutToVerify.id}/status`,
    { status: 'COMPLETED', utrNumber: `UTR-NEW-${Date.now()}` },
    adminToken
  );

  // Attempt to reject completed payout
  const rejectPaidRes = await makeRequest(
    'PATCH',
    `/api/admin/payouts/${payoutToVerify.id}/status`,
    { status: 'FAILED', rejectionReason: 'Cannot reject completed' },
    adminToken
  );

  const completedTxVerify = await prisma.walletTransaction.findUnique({
    where: { id: payoutToVerify.id },
  });

  const sc10Pass =
    emptyUtrRes.statusCode === 400 &&
    dupUtrRes.statusCode === 400 &&
    dupUtrRes.body?.message?.includes('already been') &&
    validPayRes.statusCode === 200 &&
    completedTxVerify?.status === 'COMPLETED' &&
    completedTxVerify?.utrNumber === validUtr &&
    completedTxVerify?.paidAt !== null &&
    payAgainRes.statusCode === 400 &&
    rejectPaidRes.statusCode === 400;

  auditResults.push({
    id: 10,
    scenario: 'Bank Payout & Mandatory UTR Verification',
    expected: 'Empty UTR rejected; duplicate UTR rejected; valid UTR marks COMPLETED with paidAt timestamp; already-paid cannot be paid or rejected',
    actual: `Empty UTR status: ${emptyUtrRes.statusCode}, Duplicate UTR status: ${dupUtrRes.statusCode}, Valid UTR status: ${validPayRes.statusCode}, Pay again status: ${payAgainRes.statusCode}, Reject completed status: ${rejectPaidRes.statusCode}`,
    status: sc10Pass ? 'PASS' : 'FAIL',
    evidence: `Verified UTR: ${validUtr}, paidAt: ${completedTxVerify?.paidAt?.toISOString()}`,
  });
  console.log(`Result: ${sc10Pass ? '✅ PASS' : '❌ FAIL'}\n`);

  // ------------------------------------------------------------------------
  // BONUS / DATA INTEGRITY: PostgreSQL Ledger Reconciliation
  // ------------------------------------------------------------------------
  console.log('--- Checking PostgreSQL Ledger Reconciliation ---');
  wallet = (await prisma.wallet.findUnique({ where: { id: wallet.id } }))!;
  const allTxs = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
  });

  // Calculate sum of transactions
  let calculatedBalance = 0;
  for (const t of allTxs) {
    if (t.type === 'EARNING') {
      calculatedBalance += t.amount;
    } else if (t.type === 'COMMISSION') {
      calculatedBalance -= t.amount;
    } else if (t.type === 'WITHDRAWAL') {
      calculatedBalance -= t.amount;
    } else if (t.type === 'ADJUSTMENT') {
      calculatedBalance += t.amount;
    }
  }

  const diff = Math.abs(wallet.balance - calculatedBalance);
  console.log(`Driver Wallet Balance in DB: ₹${wallet.balance}`);
  console.log(`Calculated Sum from Ledger Txs: ₹${calculatedBalance}`);
  console.log(`Discrepancy: ₹${diff.toFixed(2)}`);

  // Print Summary Table
  console.log('\n========================================================================');
  console.log('                      AUDIT VERIFICATION REPORT');
  console.log('========================================================================');
  console.table(
    auditResults.map((r) => ({
      '#': r.id,
      Scenario: r.scenario,
      Status: r.status,
      Actual: r.actual.substring(0, 60) + '...',
    }))
  );

  const allPassed = auditResults.every((r) => r.status === 'PASS');
  if (allPassed) {
    console.log('\n🎉 ALL 10 AUDIT SCENARIOS PASSED WITH 100% SUCCESS ON REAL POSTGRESQL! 🎉\n');
  } else {
    console.error('\n⚠️ SOME SCENARIOS FAILED. Check details above.');
    process.exit(1);
  }
}

runAuditSuite()
  .catch((err) => {
    console.error('Fatal audit suite error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
