import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import bcrypt from 'bcryptjs';
import { prisma } from './src/config/prisma';

// ---------------------------------------------------------------------------
// Isolated Test Fixtures Configuration (Cleaned up before and after tests)
// ---------------------------------------------------------------------------
const TEST_PHONES = {
  APPROVED_DRIVER: '9998880001',
  NULL_HASH_DRIVER: '9998880002',
  PENDING_DRIVER: '9998880003',
  REJECTED_DRIVER: '9998880004',
  CUSTOMER: '9998880005',
  UNKNOWN_DRIVER: '9998880099',
};

const FIXTURE_PHONE_LIST = Object.values(TEST_PHONES);

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

function request(method: string, path: string, body: any = null) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const url = new URL(path, 'http://127.0.0.1:3000');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode || 500, body: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await request('GET', '/health');
    return res.status === 200;
  } catch {
    return false;
  }
}

async function cleanupFixtures() {
  await prisma.user.deleteMany({
    where: { phone: { in: FIXTURE_PHONE_LIST } },
  });
}

async function setupFixtures() {
  await cleanupFixtures();

  const driverPassHash = await bcrypt.hash('ValidDriverPass123', 10);
  const pendingPassHash = await bcrypt.hash('PendingPass123', 10);
  const rejectedPassHash = await bcrypt.hash('RejectedPass123', 10);

  // 1. Approved driver with existing password
  await prisma.user.create({
    data: {
      phone: TEST_PHONES.APPROVED_DRIVER,
      name: 'Fixture Approved Driver',
      role: 'DRIVER',
      passwordHash: driverPassHash,
      isActive: true,
      driverProfile: {
        create: {
          personaType: 'DRIVE_ONLY',
          approvalStatus: 'APPROVED',
          wallet: { create: { balance: 100 } },
        },
      },
    },
  });

  // 2. Driver with null passwordHash (legacy/unmigrated driver)
  await prisma.user.create({
    data: {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      name: 'Fixture Null Hash Driver',
      role: 'DRIVER',
      passwordHash: null,
      isActive: true,
      driverProfile: {
        create: {
          personaType: 'DRIVE_ONLY',
          approvalStatus: 'APPROVED',
          wallet: { create: { balance: 0 } },
        },
      },
    },
  });

  // 3. Pending driver with password
  await prisma.user.create({
    data: {
      phone: TEST_PHONES.PENDING_DRIVER,
      name: 'Fixture Pending Driver',
      role: 'DRIVER',
      passwordHash: pendingPassHash,
      isActive: true,
      driverProfile: {
        create: {
          personaType: 'OWN_VEHICLE',
          approvalStatus: 'PENDING',
          wallet: { create: { balance: 0 } },
        },
      },
    },
  });

  // 4. Rejected driver with password
  await prisma.user.create({
    data: {
      phone: TEST_PHONES.REJECTED_DRIVER,
      name: 'Fixture Rejected Driver',
      role: 'DRIVER',
      passwordHash: rejectedPassHash,
      isActive: true,
      driverProfile: {
        create: {
          personaType: 'RENTAL',
          approvalStatus: 'REJECTED',
          rejectionReason: 'Invalid documentation provided',
          wallet: { create: { balance: 0 } },
        },
      },
    },
  });

  // 5. Customer account
  await prisma.user.create({
    data: {
      phone: TEST_PHONES.CUSTOMER,
      name: 'Fixture Customer',
      role: 'CUSTOMER',
      isActive: true,
      customerProfile: {
        create: {
          rating: 5.0,
        },
      },
    },
  });
}

async function runSecurityTests() {
  console.log('🔒 Starting Comprehensive Driver Auth & OTP Reset Security Tests...\n');

  let serverProcess: ChildProcess | null = null;
  const running = await isServerRunning();

  if (!running) {
    console.log('⚡ Server not running on :3000. Spawning test server process...');
    serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
      shell: true,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'development' },
    });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isServerRunning()) {
        ready = true;
        console.log('✅ Test server listening on http://127.0.0.1:3000\n');
        break;
      }
    }

    if (!ready) {
      throw new Error('Failed to start backend server for testing within 20 seconds');
    }
  } else {
    console.log('✅ Using running server on http://127.0.0.1:3000\n');
  }

  let passedCount = 0;
  let totalCount = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalCount++;
    if (condition) {
      console.log(`✅ PASS [Test ${totalCount}]: ${testName}`);
      passedCount++;
    } else {
      console.error(`❌ FAIL [Test ${totalCount}]: ${testName} - ${detail || ''}`);
    }
  }

  try {
    await setupFixtures();

    // -------------------------------------------------------------
    // TEST 1: Missing phone or password rejected with HTTP 400
    // -------------------------------------------------------------
    const t1a = await request('POST', '/api/auth/driver-login', { phone: TEST_PHONES.APPROVED_DRIVER });
    assert(t1a.status === 400, 'Rejects driver login with missing password (HTTP 400)', `Got ${t1a.status}`);

    const t1b = await request('POST', '/api/auth/driver-login', { password: 'ValidDriverPass123' });
    assert(t1b.status === 400, 'Rejects driver login with missing phone (HTTP 400)', `Got ${t1b.status}`);

    const t1c = await request('POST', '/api/auth/driver-login', { phone: '', password: '' });
    assert(t1c.status === 400, 'Rejects driver login with empty strings (HTTP 400)', `Got ${t1c.status}`);

    // -------------------------------------------------------------
    // TEST 2: Unknown driver login rejected without account creation
    // -------------------------------------------------------------
    const beforeCount = await prisma.user.count({ where: { phone: TEST_PHONES.UNKNOWN_DRIVER } });
    const t2 = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.UNKNOWN_DRIVER,
      password: 'any_password_123',
    });
    assert(t2.status === 401, 'Rejects unknown driver login with HTTP 401', `Got ${t2.status}`);

    const afterCount = await prisma.user.count({ where: { phone: TEST_PHONES.UNKNOWN_DRIVER } });
    assert(beforeCount === 0 && afterCount === 0, 'Does NOT auto-create unknown driver account', `Count was ${afterCount}`);

    // -------------------------------------------------------------
    // TEST 3: Existing valid password succeeds for an approved driver
    // -------------------------------------------------------------
    const t3 = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.APPROVED_DRIVER,
      password: 'ValidDriverPass123',
      personaType: 'DRIVE_ONLY',
    });
    assert(t3.status === 200 && t3.body?.success === true, 'Approved driver logs in with valid password (HTTP 200)', `Got ${t3.status}`);
    assert(!!t3.body?.data?.token, 'Returns valid signed JWT token for approved driver');
    assert(t3.body?.data?.driverProfile?.approvalStatus === 'APPROVED', 'Driver profile returns APPROVED status');

    // -------------------------------------------------------------
    // TEST 4: Incorrect password fails
    // -------------------------------------------------------------
    const t4 = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.APPROVED_DRIVER,
      password: 'WrongPassword999',
    });
    assert(t4.status === 401, 'Rejects incorrect password with HTTP 401', `Got status ${t4.status}`);
    assert(t4.body?.success === false, 'Response indicates success: false on wrong password');

    // -------------------------------------------------------------
    // TEST 5: Driver with null passwordHash cannot log in and DB record remains unchanged (Lazy migration removed)
    // -------------------------------------------------------------
    const beforeNullDriver = await prisma.user.findUnique({
      where: { phone: TEST_PHONES.NULL_HASH_DRIVER },
    });
    assert(beforeNullDriver?.passwordHash === null, 'Pre-condition: fixture driver has null passwordHash');

    const t5 = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      password: 'AttemptedPassword123',
    });
    assert(t5.status === 401, 'Rejects driver with null passwordHash with HTTP 401', `Got status ${t5.status}`);
    assert(
      t5.body?.message?.toLowerCase().includes('otp') || t5.body?.message?.toLowerCase().includes('set up'),
      'Safe error message directs driver to OTP setup',
      `Got message: "${t5.body?.message}"`
    );

    const afterNullDriver = await prisma.user.findUnique({
      where: { phone: TEST_PHONES.NULL_HASH_DRIVER },
    });
    assert(
      afterNullDriver?.passwordHash === null,
      'Crucial: database record remains unchanged (no lazy migration password adoption)',
      `passwordHash was ${afterNullDriver?.passwordHash}`
    );

    // -------------------------------------------------------------
    // TEST 6: Pending/rejected drivers cannot log in or become approved through login
    // -------------------------------------------------------------
    const t6Pending = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.PENDING_DRIVER,
      password: 'PendingPass123',
    });
    assert(t6Pending.status === 401, 'Rejects PENDING driver with HTTP 401', `Got status ${t6Pending.status}`);
    assert(t6Pending.body?.message?.includes('pending'), 'Message explains driver account is pending approval');

    const checkPending = await prisma.driverProfile.findFirst({
      where: { user: { phone: TEST_PHONES.PENDING_DRIVER } },
    });
    assert(checkPending?.approvalStatus === 'PENDING', 'Failed login attempt does NOT auto-approve PENDING driver');

    const t6Rejected = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.REJECTED_DRIVER,
      password: 'RejectedPass123',
    });
    assert(t6Rejected.status === 401, 'Rejects REJECTED driver with HTTP 401', `Got status ${t6Rejected.status}`);
    assert(t6Rejected.body?.message?.includes('rejected'), 'Message explains driver account is rejected');

    const checkRejected = await prisma.driverProfile.findFirst({
      where: { user: { phone: TEST_PHONES.REJECTED_DRIVER } },
    });
    assert(checkRejected?.approvalStatus === 'REJECTED', 'Failed login attempt does NOT alter REJECTED status');

    // -------------------------------------------------------------
    // TEST 7: Customer accounts cannot use driver login
    // -------------------------------------------------------------
    const t7 = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.CUSTOMER,
      password: 'any_customer_password',
    });
    assert(t7.status === 401, 'Rejects customer account attempting driver login with HTTP 401', `Got ${t7.status}`);

    // -------------------------------------------------------------
    // TEST 8: Missing, incorrect, expired, reused, or wrong-purpose OTP is rejected
    // -------------------------------------------------------------
    // 8a: Missing fields on reset-password
    const t8a = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
    });
    assert(t8a.status === 400, 'Rejects reset-password with missing OTP and newPassword (HTTP 400)', `Got ${t8a.status}`);

    // 8b: Password too short (< 6 chars)
    const t8b = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      otp: '123456',
      newPassword: '123',
    });
    assert(t8b.status === 400, 'Rejects password shorter than 6 characters (HTTP 400)', `Got ${t8b.status}`);

    // 8c: Wrong-purpose OTP: send OTP with intent 'LOGIN'
    const sendLoginOtp = await request('POST', '/api/auth/send-otp', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      intent: 'LOGIN',
    });
    assert(sendLoginOtp.status === 200, 'Successfully sent OTP with LOGIN intent');
    const loginOtpVal = sendLoginOtp.body?.devOtp || '123456';

    const t8c = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      otp: loginOtpVal,
      newPassword: 'SecureNewPassword123',
    });
    assert(
      t8c.status === 400 && t8c.body?.message?.includes('not issued for password reset'),
      'Rejects OTP issued for wrong purpose (LOGIN instead of RESET_PASSWORD)',
      `Got status ${t8c.status}: ${t8c.body?.message}`
    );

    // 8d: Incorrect OTP
    await request('POST', '/api/auth/send-otp', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      intent: 'RESET_PASSWORD',
    });
    const t8d = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      otp: '000000', // wrong OTP
      newPassword: 'SecureNewPassword123',
    });
    assert(t8d.status === 400, 'Rejects incorrect OTP with HTTP 400', `Got ${t8d.status}`);

    // -------------------------------------------------------------
    // TEST 9: Valid OTP allows password setup/reset for an eligible account
    // -------------------------------------------------------------
    const sendResetOtp = await request('POST', '/api/auth/send-otp', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      intent: 'RESET_PASSWORD',
    });
    assert(sendResetOtp.status === 200, 'OTP sent for RESET_PASSWORD purpose (HTTP 200)');
    const resetOtpVal = sendResetOtp.body?.devOtp || '123456';

    const t9 = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      otp: resetOtpVal,
      newPassword: 'BrandNewPassword123',
    });
    assert(t9.status === 200 && t9.body?.success === true, 'Valid OTP successfully sets password (HTTP 200)', `Got ${t9.status}`);

    // Verify hash in database is valid bcrypt hash matching new password
    const updatedNullDriver = await prisma.user.findUnique({
      where: { phone: TEST_PHONES.NULL_HASH_DRIVER },
    });
    const isNewHashValid = updatedNullDriver?.passwordHash
      ? await bcrypt.compare('BrandNewPassword123', updatedNullDriver.passwordHash)
      : false;
    assert(isNewHashValid, 'Database contains valid bcrypt hash matching new password');

    // Now driver login must succeed with the new password
    const t9Login = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      password: 'BrandNewPassword123',
    });
    assert(t9Login.status === 200 && t9Login.body?.success === true, 'Driver can immediately log in with newly set password (HTTP 200)');

    // -------------------------------------------------------------
    // TEST 10: Reset cannot create an unknown account
    // -------------------------------------------------------------
    const t10 = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.UNKNOWN_DRIVER,
      otp: '123456',
      newPassword: 'SomePassword123',
    });
    assert(t10.status === 400 || t10.status === 404, 'Reset password rejects unknown account (HTTP 400/404)', `Got ${t10.status}`);

    const countUnknown = await prisma.user.count({
      where: { phone: TEST_PHONES.UNKNOWN_DRIVER },
    });
    assert(countUnknown === 0, 'Reset password did NOT create unknown account in PostgreSQL');

    // -------------------------------------------------------------
    // TEST 11: OTP cannot be reused after successful reset
    // -------------------------------------------------------------
    const t11 = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.NULL_HASH_DRIVER,
      otp: resetOtpVal,
      newPassword: 'AnotherPassword456',
    });
    assert(t11.status === 400, 'Reused OTP is rejected with HTTP 400 (one-time use enforced)', `Got ${t11.status}`);

    // -------------------------------------------------------------
    // TEST 12: Existing password cannot be overwritten without intended verified reset flow
    // -------------------------------------------------------------
    const t12Tamper = await request('POST', '/api/auth/reset-password', {
      phone: TEST_PHONES.APPROVED_DRIVER,
      otp: '999999', // invalid OTP
      newPassword: 'HackedPassword123',
    });
    assert(t12Tamper.status === 400, 'Tamper attempt without valid OTP rejected with HTTP 400');

    // Verify existing password remains valid and unchanged
    const t12VerifyOriginal = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.APPROVED_DRIVER,
      password: 'ValidDriverPass123',
    });
    assert(t12VerifyOriginal.status === 200, 'Original driver password remains intact and valid');

    const t12VerifyHacked = await request('POST', '/api/auth/driver-login', {
      phone: TEST_PHONES.APPROVED_DRIVER,
      password: 'HackedPassword123',
    });
    assert(t12VerifyHacked.status === 401, 'Unauthorized new password was NOT saved');

    // -------------------------------------------------------------
    // TEST 13: Existing authentication (Customer OTP & Admin password) remains passing
    // -------------------------------------------------------------
    // 13a: Customer OTP send & login
    const sendCustOtp = await request('POST', '/api/auth/send-otp', {
      phone: TEST_PHONES.CUSTOMER,
      intent: 'LOGIN',
    });
    assert(sendCustOtp.status === 200, 'Customer OTP send succeeds (HTTP 200)');
    const custOtpVal = sendCustOtp.body?.devOtp || '123456';

    const custLogin = await request('POST', '/api/auth/verify-otp', {
      phone: TEST_PHONES.CUSTOMER,
      otp: custOtpVal,
      role: 'CUSTOMER',
    });
    assert(custLogin.status === 200 && !!custLogin.body?.data?.token, 'Customer OTP login succeeds and issues JWT (HTTP 200)');

    // 13b: Admin password login
    const adminLoginRes = await request('POST', '/api/auth/admin-login', {
      identifier: 'admin@goldencabs.com',
      password: 'admin123',
    });
    assert(adminLoginRes.status === 200 && !!adminLoginRes.body?.data?.token, 'Admin password login succeeds and issues JWT (HTTP 200)');

    // 13c: Ride fare estimate endpoint remains functional
    const rideEstimate = await request('POST', '/api/rides/estimate', {
      pickupLat: 11.9338,
      pickupLng: 79.8358,
      dropLat: 11.9360,
      dropLng: 79.8174,
      vehicleType: 'SEDAN',
      tripType: 'DAILY',
    });
    assert(rideEstimate.status === 200, 'Ride estimate endpoint remains healthy (HTTP 200)', `Got status ${rideEstimate.status}: ${JSON.stringify(rideEstimate.body)}`);

  } finally {
    // Isolated fixture cleanup
    console.log('\n🧹 Cleaning up isolated test fixtures from PostgreSQL...');
    await cleanupFixtures();
    console.log('✅ Test fixtures cleaned up successfully.');

    if (serverProcess) {
      console.log('🛑 Stopping test server process...');
      serverProcess.kill('SIGINT');
    }
  }

  console.log(`\n🏁 Security Test Suite Complete: ${passedCount}/${totalCount} tests passed.\n`);
  process.exit(passedCount === totalCount ? 0 : 1);
}

runSecurityTests().catch((e) => {
  console.error('Test execution error:', e);
  process.exit(1);
});
