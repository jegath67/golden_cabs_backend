import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { driversService } from '../src/modules/drivers/drivers.service';

async function runTests() {
  const stamp = Date.now().toString();
  console.log(`[TEST] Starting Driver Management Approved-Only Filter Test Suite (stamp: ${stamp})`);

  let approvedActiveUserId = '';
  let approvedActiveProfileId = '';
  let approvedInactiveUserId = '';
  let approvedInactiveProfileId = '';
  let pendingUserId = '';
  let pendingProfileId = '';
  let rejectedUserId = '';
  let rejectedProfileId = '';

  try {
    // 1. Create Test Drivers
    // Driver 1: Approved & Active
    const u1 = await prisma.user.create({
      data: {
        phone: `9331${stamp.slice(-6)}`,
        name: `Approved Active Driver ${stamp}`,
        role: 'DRIVER',
        isActive: true,
      },
    });
    approvedActiveUserId = u1.id;
    const p1 = await prisma.driverProfile.create({
      data: {
        userId: u1.id,
        approvalStatus: 'APPROVED',
        personaType: 'DRIVE_ONLY',
      },
    });
    approvedActiveProfileId = p1.id;

    // Driver 2: Approved & Inactive (disabled by admin, but approved)
    const u2 = await prisma.user.create({
      data: {
        phone: `9332${stamp.slice(-6)}`,
        name: `Approved Inactive Driver ${stamp}`,
        role: 'DRIVER',
        isActive: false,
      },
    });
    approvedInactiveUserId = u2.id;
    const p2 = await prisma.driverProfile.create({
      data: {
        userId: u2.id,
        approvalStatus: 'APPROVED',
        personaType: 'DRIVE_ONLY',
      },
    });
    approvedInactiveProfileId = p2.id;

    // Driver 3: Pending
    const u3 = await prisma.user.create({
      data: {
        phone: `9333${stamp.slice(-6)}`,
        name: `Pending Driver ${stamp}`,
        role: 'DRIVER',
        isActive: true,
      },
    });
    pendingUserId = u3.id;
    const p3 = await prisma.driverProfile.create({
      data: {
        userId: u3.id,
        approvalStatus: 'PENDING',
        personaType: 'DRIVE_ONLY',
      },
    });
    pendingProfileId = p3.id;

    // Driver 4: Rejected
    const u4 = await prisma.user.create({
      data: {
        phone: `9334${stamp.slice(-6)}`,
        name: `Rejected Driver ${stamp}`,
        role: 'DRIVER',
        isActive: true,
      },
    });
    rejectedUserId = u4.id;
    const p4 = await prisma.driverProfile.create({
      data: {
        userId: u4.id,
        approvalStatus: 'REJECTED',
        rejectionReason: 'Invalid documentation',
        personaType: 'DRIVE_ONLY',
      },
    });
    rejectedProfileId = p4.id;

    console.log('[TEST] Seeded 4 test driver profiles (Approved Active, Approved Inactive, Pending, Rejected)');

    // 2. Test 1: Query with approvalStatus = 'APPROVED' (Driver Management query)
    const approvedResults = await driversService.getAllDrivers({ approvalStatus: 'APPROVED' });
    const approvedIds = approvedResults.map((d) => d.id);

    assert.ok(approvedIds.includes(approvedActiveProfileId), 'APPROVED Active driver must appear in Driver Management');
    assert.ok(approvedIds.includes(approvedInactiveProfileId), 'APPROVED Inactive driver must appear in Driver Management');
    assert.ok(!approvedIds.includes(pendingProfileId), 'PENDING driver must NOT appear in Driver Management');
    assert.ok(!approvedIds.includes(rejectedProfileId), 'REJECTED driver must NOT appear in Driver Management');

    // Case-insensitivity verification ('approved')
    const lowerResults = await driversService.getAllDrivers({ approvalStatus: 'approved' as any });
    const lowerIds = lowerResults.map((d) => d.id);
    assert.ok(lowerIds.includes(approvedActiveProfileId), 'Case-insensitive approved filter must include approved driver');
    assert.ok(!lowerIds.includes(rejectedProfileId), 'Case-insensitive approved filter must exclude rejected driver');

    console.log('✔ Test 1 Passed: Driver Management APPROVED-only query correctly includes only APPROVED drivers (active and inactive) and excludes PENDING and REJECTED.');

    // 3. Test 2: Query without approvalStatus filter (Approval Management query)
    const allResults = await driversService.getAllDrivers();
    const allIds = allResults.map((d) => d.id);

    assert.ok(allIds.includes(approvedActiveProfileId), 'Approval Management query without status filter must include approved active');
    assert.ok(allIds.includes(approvedInactiveProfileId), 'Approval Management query without status filter must include approved inactive');
    assert.ok(allIds.includes(pendingProfileId), 'Approval Management query without status filter must include pending');
    assert.ok(allIds.includes(rejectedProfileId), 'Approval Management query without status filter must include rejected');

    console.log('✔ Test 2 Passed: Query without approval filter preserves all records for Approval Management.');

    // 4. Test 3: Query with approvalStatus = 'PENDING'
    const pendingResults = await driversService.getAllDrivers({ approvalStatus: 'PENDING' });
    const pendingIds = pendingResults.map((d) => d.id);
    assert.ok(pendingIds.includes(pendingProfileId), 'PENDING filter includes pending driver');
    assert.ok(!pendingIds.includes(approvedActiveProfileId), 'PENDING filter excludes approved driver');
    assert.ok(!pendingIds.includes(rejectedProfileId), 'PENDING filter excludes rejected driver');

    console.log('✔ Test 3 Passed: Query with PENDING filter correctly isolates pending driver.');

    // 5. Test 4: Query with approvalStatus = 'REJECTED'
    const rejectedResults = await driversService.getAllDrivers({ approvalStatus: 'REJECTED' });
    const rejectedIds = rejectedResults.map((d) => d.id);
    assert.ok(rejectedIds.includes(rejectedProfileId), 'REJECTED filter includes rejected driver');
    assert.ok(!rejectedIds.includes(approvedActiveProfileId), 'REJECTED filter excludes approved driver');
    assert.ok(!rejectedIds.includes(pendingProfileId), 'REJECTED filter excludes pending driver');

    console.log('✔ Test 4 Passed: Query with REJECTED filter correctly isolates rejected driver.');

    console.log('\n=========================================');
    console.log('ALL BACKEND DRIVER APPROVAL FILTER TESTS PASSED');
    console.log('=========================================\n');
  } finally {
    // Cleanup test records
    const profileIds = [approvedActiveProfileId, approvedInactiveProfileId, pendingProfileId, rejectedProfileId].filter(Boolean);
    const userIds = [approvedActiveUserId, approvedInactiveUserId, pendingUserId, rejectedUserId].filter(Boolean);

    if (profileIds.length > 0) {
      await prisma.driverProfile.deleteMany({ where: { id: { in: profileIds } } }).catch(() => {});
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
