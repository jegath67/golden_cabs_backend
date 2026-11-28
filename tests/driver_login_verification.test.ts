import { prisma } from '../src/config/prisma';
import { authService } from '../src/modules/auth/auth.service';

async function runTests() {
  console.log('======================================================');
  console.log('[TEST] Starting Driver Login Verification Suite');
  console.log('======================================================\n');

  const testPhoneBase = '98000';
  const unknownPhone = `${testPhoneBase}11111`;
  const customerOnlyPhone = `${testPhoneBase}22222`;
  const pendingDriverPhone = `${testPhoneBase}33333`;
  const rejectedDriverPhone = `${testPhoneBase}44444`;
  const approvedDriverPhone = `${testPhoneBase}55555`;

  try {
    // 0. Setup test records
    console.log('[SETUP] Cleaning old test records if any...');
    const allPhones = [customerOnlyPhone, pendingDriverPhone, rejectedDriverPhone, approvedDriverPhone];
    await prisma.driverProfile.deleteMany({
      where: { user: { phone: { in: allPhones } } },
    });
    await prisma.user.deleteMany({
      where: { phone: { in: allPhones } },
    });

    console.log('[SETUP] Creating test users...');
    // Customer only
    await prisma.user.create({
      data: {
        phone: customerOnlyPhone,
        name: 'Test Customer Only',
        role: 'CUSTOMER',
        customerProfile: { create: {} },
      },
    });

    // Pending Driver
    await prisma.user.create({
      data: {
        phone: pendingDriverPhone,
        name: 'Test Pending Driver',
        role: 'DRIVER',
        driverProfile: {
          create: {
            approvalStatus: 'PENDING',
            personaType: 'DRIVE_ONLY',
          },
        },
      },
    });

    // Rejected Driver
    await prisma.user.create({
      data: {
        phone: rejectedDriverPhone,
        name: 'Test Rejected Driver',
        role: 'DRIVER',
        driverProfile: {
          create: {
            approvalStatus: 'REJECTED',
            rejectionReason: 'Blurry documents',
            personaType: 'DRIVE_ONLY',
          },
        },
      },
    });

    // Approved Driver
    await prisma.user.create({
      data: {
        phone: approvedDriverPhone,
        name: 'Test Approved Driver',
        role: 'DRIVER',
        driverProfile: {
          create: {
            approvalStatus: 'APPROVED',
            personaType: 'OWN_VEHICLE',
          },
        },
      },
    });

    // --- TEST 1: Unknown number + DRIVER LOGIN -> 404 DRIVER_NOT_FOUND ---
    console.log('--- Test 1: Unknown number + DRIVER LOGIN -> 404 DRIVER_NOT_FOUND ---');
    try {
      await authService.sendOtp(unknownPhone, 'LOGIN', 'DRIVER');
      throw new Error('Test 1 Failed: Expected 404 error but OTP was sent');
    } catch (err: any) {
      if (err.statusCode === 404 && err.code === 'DRIVER_NOT_FOUND') {
        console.log('✓ Correctly rejected with 404 DRIVER_NOT_FOUND');
      } else {
        throw new Error(`Test 1 Failed: Received wrong error: ${err.message} (status: ${err.statusCode}, code: ${err.code})`);
      }
    }

    // --- TEST 2: Customer-only account + DRIVER LOGIN -> 404 DRIVER_NOT_FOUND ---
    console.log('\n--- Test 2: Customer-only account + DRIVER LOGIN -> 404 DRIVER_NOT_FOUND ---');
    try {
      await authService.sendOtp(customerOnlyPhone, 'LOGIN', 'DRIVER');
      throw new Error('Test 2 Failed: Expected 404 error for customer-only user');
    } catch (err: any) {
      if (err.statusCode === 404 && err.code === 'DRIVER_NOT_FOUND') {
        console.log('✓ Correctly rejected with 404 DRIVER_NOT_FOUND for Customer-only user');
      } else {
        throw new Error(`Test 2 Failed: Received wrong error: ${err.message} (status: ${err.statusCode}, code: ${err.code})`);
      }
    }

    // --- TEST 3: PENDING DriverProfile + DRIVER LOGIN -> OTP allowed ---
    console.log('\n--- Test 3: PENDING DriverProfile + DRIVER LOGIN -> OTP allowed ---');
    const pendingResult = await authService.sendOtp(pendingDriverPhone, 'LOGIN', 'DRIVER');
    if (pendingResult && pendingResult.message?.includes('OTP sent successfully')) {
      console.log('✓ PENDING Driver allowed to receive OTP');
    } else {
      throw new Error('Test 3 Failed: PENDING driver did not receive OTP result');
    }

    // --- TEST 4: REJECTED DriverProfile + DRIVER LOGIN -> OTP allowed ---
    console.log('\n--- Test 4: REJECTED DriverProfile + DRIVER LOGIN -> OTP allowed ---');
    const rejectedResult = await authService.sendOtp(rejectedDriverPhone, 'LOGIN', 'DRIVER');
    if (rejectedResult && rejectedResult.message?.includes('OTP sent successfully')) {
      console.log('✓ REJECTED Driver allowed to receive OTP (to view rejection status/reapply)');
    } else {
      throw new Error('Test 4 Failed: REJECTED driver did not receive OTP result');
    }

    // --- TEST 5: APPROVED DriverProfile + DRIVER LOGIN -> OTP allowed ---
    console.log('\n--- Test 5: APPROVED DriverProfile + DRIVER LOGIN -> OTP allowed ---');
    const approvedResult = await authService.sendOtp(approvedDriverPhone, 'LOGIN', 'DRIVER');
    if (approvedResult && approvedResult.message?.includes('OTP sent successfully')) {
      console.log('✓ APPROVED Driver allowed to receive OTP');
    } else {
      throw new Error('Test 5 Failed: APPROVED driver did not receive OTP result');
    }

    // --- TEST 6: CUSTOMER LOGIN behavior unchanged ---
    console.log('\n--- Test 6: CUSTOMER LOGIN behavior unchanged ---');
    // Customer without role or role=CUSTOMER logging into customer account
    const customerLoginResult = await authService.sendOtp(customerOnlyPhone, 'LOGIN', 'CUSTOMER');
    if (customerLoginResult && customerLoginResult.message?.includes('OTP sent successfully')) {
      console.log('✓ Customer allowed to receive OTP for Customer login');
    } else {
      throw new Error('Test 6 Failed: Customer did not receive OTP for Customer login');
    }

    // Customer without role parameter
    const noRoleResult = await authService.sendOtp(customerOnlyPhone, 'LOGIN');
    if (noRoleResult && noRoleResult.message?.includes('OTP sent successfully')) {
      console.log('✓ Request without role preserved and allowed for existing user');
    } else {
      throw new Error('Test 6 Failed: Request without role failed for existing user');
    }

    // --- TEST 7: REGISTER intent behavior unchanged ---
    console.log('\n--- Test 7: REGISTER intent behavior unchanged ---');
    // Unregistered number can request REGISTER OTP
    const registerOtpResult = await authService.sendOtp(unknownPhone, 'REGISTER');
    if (registerOtpResult && registerOtpResult.message?.includes('OTP sent successfully')) {
      console.log('✓ REGISTER intent for unregistered number allowed');
    } else {
      throw new Error('Test 7 Failed: REGISTER intent did not return OTP');
    }

    // Already registered number cannot request REGISTER OTP
    try {
      await authService.sendOtp(approvedDriverPhone, 'REGISTER');
      throw new Error('Test 7 Failed: Expected duplicate registration error');
    } catch (err: any) {
      if (err.message.includes('already registered')) {
        console.log('✓ REGISTER intent for existing user correctly rejected with "already registered"');
      } else {
        throw new Error(`Test 7 Failed: Wrong error for existing user register: ${err.message}`);
      }
    }

    console.log('\n======================================================');
    console.log('ALL BACKEND DRIVER LOGIN VERIFICATION TESTS PASSED! ✓');
    console.log('======================================================');
  } finally {
    console.log('\n[CLEANUP] Cleaning up test records...');
    const allPhones = [customerOnlyPhone, pendingDriverPhone, rejectedDriverPhone, approvedDriverPhone];
    await prisma.driverProfile.deleteMany({
      where: { user: { phone: { in: allPhones } } },
    });
    await prisma.user.deleteMany({
      where: { phone: { in: allPhones } },
    });
    console.log('[CLEANUP] Done.');
  }
}

runTests().catch((e) => {
  console.error('Test Suite Failed:', e);
  process.exit(1);
});
