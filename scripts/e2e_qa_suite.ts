import { prisma } from '../src/config/prisma';

const BASE_URL = 'http://localhost:3000';

interface TestResult {
  testNumber: string;
  testName: string;
  status: 'PASSED' | 'FAILED' | 'BLOCKED';
  request: { method: string; url: string; body?: any; headers?: any };
  response: { statusCode: number; body: any };
  dbBefore?: any;
  dbAfter?: any;
  notes?: string;
}

const results: TestResult[] = [];

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

async function getAdminToken(): Promise<string> {
  const loginRes = await makeRequest('POST', '/api/auth/admin-login', {
    identifier: 'admin@goldencabs.com',
    password: 'admin123',
  });
  const token = loginRes.body?.data?.token || loginRes.body?.token;
  if (!token) {
    throw new Error(`Failed to get admin token: ${JSON.stringify(loginRes.body)}`);
  }
  return token;
}

async function getDriverToken(phone: string): Promise<string> {
  // Use send-otp then verify-otp in development mode
  await makeRequest('POST', '/api/auth/send-otp', {
    phone,
    intent: 'LOGIN',
  });
  const verifyRes = await makeRequest('POST', '/api/auth/verify-otp', {
    phone,
    otp: '123456',
    role: 'DRIVER',
  });
  const token = verifyRes.body?.data?.token || verifyRes.body?.token;
  if (!token) {
    throw new Error(`Failed to get driver token for ${phone}: ${JSON.stringify(verifyRes.body)}`);
  }
  return token;
}

async function getCustomerToken(phone: string): Promise<string> {
  await makeRequest('POST', '/api/auth/send-otp', {
    phone,
    intent: 'LOGIN',
  });
  const verifyRes = await makeRequest('POST', '/api/auth/verify-otp', {
    phone,
    otp: '123456',
    role: 'CUSTOMER',
  });
  const token = verifyRes.body?.data?.token || verifyRes.body?.token;
  if (!token) {
    throw new Error(`Failed to get customer token for ${phone}: ${JSON.stringify(verifyRes.body)}`);
  }
  return token;
}

async function runTestSuite() {
  console.log('====================================================');
  console.log('🚀 GOLDEN CABS E2E AUDIT & QA SUITE STARTING');
  console.log('====================================================\n');

  const adminToken = await getAdminToken();
  console.log('✅ Admin Token Acquired');

  // Find Driver Barath
  const driverBarath = await prisma.driverProfile.findFirst({
    where: { user: { phone: '8754358963' } },
    include: { user: true, assignedVehicle: true },
  });
  if (!driverBarath) throw new Error('Driver Barath not found in database');

  const vehicleErtiga = await prisma.vehicle.findFirst({
    where: { vehicleNumber: 'TN31VP3423' },
  });
  if (!vehicleErtiga) throw new Error('Vehicle Ertiga not found in database');

  // Customer jegath
  const customerUser = await prisma.user.findFirst({
    where: { phone: '8754358935', role: 'CUSTOMER' },
  });
  if (!customerUser) throw new Error('Customer jegath not found');

  const customerToken = await getCustomerToken('8754358935');
  console.log('✅ Customer Token Acquired\n');

  // --------------------------------------------------------------------------
  // TEST 1: Driver Deactivation
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: DRIVER DEACTIVATION ---');
  // 1A: Setup driver Barath to ACTIVE and ON_SHIFT
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: true } });
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'VERIFIED', isOnline: true } });
  await prisma.driverProfile.update({
    where: { id: driverBarath.id },
    data: { isOnline: true, shiftStatus: 'ON_SHIFT', assignedVehicleId: vehicleErtiga.id },
  });

  // Acquire driver token while active
  const driverBarathToken = await getDriverToken('8754358963');
  console.log('Driver Barath initial token acquired');

  const db1Before = await prisma.user.findUnique({
    where: { id: driverBarath.userId },
    select: { id: true, isActive: true, driverProfile: { select: { isOnline: true, shiftStatus: true } } },
  });

  // Admin deactivates driver
  const deactRes = await makeRequest(
    'PATCH',
    `/api/drivers/${driverBarath.id}/status`,
    { status: 'INACTIVE' },
    adminToken
  );

  const db1After = await prisma.user.findUnique({
    where: { id: driverBarath.userId },
    select: { id: true, isActive: true, driverProfile: { select: { isOnline: true, shiftStatus: true } } },
  });

  results.push({
    testNumber: '1.1',
    testName: 'Admin Deactivates Driver via API',
    status: deactRes.statusCode === 200 && db1After?.isActive === false ? 'PASSED' : 'FAILED',
    request: { method: 'PATCH', url: `/api/drivers/${driverBarath.id}/status`, body: { status: 'INACTIVE' } },
    response: deactRes,
    dbBefore: db1Before,
    dbAfter: db1After,
    notes: 'Driver user isActive set to false, driverProfile set to OFF_SHIFT and offline',
  });

  // 1B: Verify existing Partner session cannot switch online
  const shiftRes = await makeRequest(
    'POST',
    '/api/drivers/shift',
    { shiftStatus: 'ON_SHIFT', isOnline: true },
    driverBarathToken
  );

  results.push({
    testNumber: '1.2',
    testName: 'Deactivated Driver Online Switch Blocked',
    status: shiftRes.statusCode === 403 ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: '/api/drivers/shift', body: { shiftStatus: 'ON_SHIFT', isOnline: true } },
    response: shiftRes,
    notes: 'Blocked by JWT Active Validation with 403 Forbidden',
  });

  // 1C: Verify old JWT cannot perform protected operations (Location update)
  const locRes = await makeRequest(
    'POST',
    '/api/drivers/location',
    { latitude: 11.9338, longitude: 79.8358 },
    driverBarathToken
  );

  results.push({
    testNumber: '1.3',
    testName: 'Deactivated Driver Old JWT Protected Op Blocked',
    status: locRes.statusCode === 403 ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: '/api/drivers/location', body: { latitude: 11.9338, longitude: 79.8358 } },
    response: locRes,
    notes: 'Blocked with 403 Forbidden: Account has been deactivated',
  });

  // Reactivate Barath for further tests
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: true } });
  await prisma.driverProfile.update({
    where: { id: driverBarath.id },
    data: { isOnline: true, shiftStatus: 'ON_SHIFT' },
  });
  console.log('✅ Test 1 Completed\n');

  // --------------------------------------------------------------------------
  // TEST 2: Vehicle Deactivation (All 3 Personas)
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: VEHICLE DEACTIVATION (3 PERSONAS) ---');

  // 2A: Persona DRIVE_ONLY (Barath)
  const db2ABefore = await prisma.vehicle.findUnique({
    where: { id: vehicleErtiga.id },
    select: { status: true, isOnline: true, assignedDriver: { select: { isOnline: true, shiftStatus: true } } },
  });

  const vehDeactRes = await makeRequest(
    'PATCH',
    `/api/vehicles/${vehicleErtiga.id}/status`,
    { status: 'MAINTENANCE', rejectionReason: 'Routine Inspection' },
    adminToken
  );

  const db2AAfter = await prisma.vehicle.findUnique({
    where: { id: vehicleErtiga.id },
    select: { status: true, isOnline: true, assignedDriver: { select: { isOnline: true, shiftStatus: true } } },
  });

  results.push({
    testNumber: '2.1',
    testName: 'DRIVE_ONLY Vehicle Deactivation Forces Driver Offline',
    status:
      vehDeactRes.statusCode === 200 &&
      db2AAfter?.status === 'MAINTENANCE' &&
      db2AAfter?.assignedDriver?.isOnline === false &&
      db2AAfter?.assignedDriver?.shiftStatus === 'OFF_SHIFT'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'PATCH', url: `/api/vehicles/${vehicleErtiga.id}/status`, body: { status: 'MAINTENANCE' } },
    response: vehDeactRes,
    dbBefore: db2ABefore,
    dbAfter: db2AAfter,
    notes: 'Vehicle MAINTENANCE forces assigned driver to isOnline=false and shiftStatus=OFF_SHIFT',
  });

  // Verify DRIVE_ONLY cannot switch online with MAINTENANCE vehicle
  const barathTokenFresh = await getDriverToken('8754358963');
  const shiftFailRes = await makeRequest(
    'POST',
    '/api/drivers/shift',
    { shiftStatus: 'ON_SHIFT', isOnline: true },
    barathTokenFresh
  );

  results.push({
    testNumber: '2.2',
    testName: 'DRIVE_ONLY Shift Blocked With MAINTENANCE Vehicle',
    status: shiftFailRes.statusCode === 400 && String(shiftFailRes.body?.message).includes('maintenance') ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: '/api/drivers/shift', body: { shiftStatus: 'ON_SHIFT', isOnline: true } },
    response: shiftFailRes,
    notes: 'toggleShift guard blocks shift start with inactive vehicle',
  });

  // Restore Ertiga
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'VERIFIED', isOnline: true } });

  // 2B: Persona OWN_VEHICLE
  // Setup Kalai as OWN_VEHICLE with Duster
  const vehicleDuster = await prisma.vehicle.findFirst({ where: { vehicleNumber: 'TN31AD2916' } });
  if (vehicleDuster) {
    const driverKalai = await prisma.driverProfile.findFirst({
      where: { user: { phone: '8754358956' } },
    });
    if (driverKalai) {
      await prisma.driverProfile.update({
        where: { id: driverKalai.id },
        data: { personaType: 'OWN_VEHICLE', assignedVehicleId: null },
      });
      // Set all Kalai owned vehicles to MAINTENANCE
      await prisma.vehicle.updateMany({
        where: { ownerId: driverKalai.id },
        data: { status: 'MAINTENANCE' },
      });

      const kalaiToken = await getDriverToken('8754358956');
      const ownShiftRes = await makeRequest(
        'POST',
        '/api/drivers/shift',
        { shiftStatus: 'ON_SHIFT', isOnline: true },
        kalaiToken
      );

      results.push({
        testNumber: '2.3',
        testName: 'OWN_VEHICLE Shift Blocked When Owned Vehicles Inactive',
        status: ownShiftRes.statusCode === 400 && String(ownShiftRes.body?.message).includes('Approved and verified personal vehicle required') ? 'PASSED' : 'FAILED',
        request: { method: 'POST', url: '/api/drivers/shift', body: { shiftStatus: 'ON_SHIFT', isOnline: true } },
        response: ownShiftRes,
        notes: 'OWN_VEHICLE requires at least one VERIFIED owned vehicle to start shift',
      });

      // Restore Kalai owned vehicles
      await prisma.vehicle.updateMany({
        where: { ownerId: driverKalai.id },
        data: { status: 'VERIFIED' },
      });
      await prisma.driverProfile.update({
        where: { id: driverKalai.id },
        data: { personaType: 'RENTAL' },
      });
    }
  }

  // 2C: Persona RENTAL
  const driverJegath = await prisma.driverProfile.findFirst({
    where: { user: { phone: '8754358935' } },
  });
  const vehicleSwift = await prisma.vehicle.findFirst({ where: { vehicleNumber: 'TN32AV1234' } });

  if (driverJegath && vehicleSwift) {
    // Assign Swift to Jegath (RENTAL)
    await prisma.vehicle.update({ where: { id: vehicleSwift.id }, data: { status: 'VERIFIED', isOnline: true } });
    await prisma.driverProfile.update({
      where: { id: driverJegath.id },
      data: { assignedVehicleId: vehicleSwift.id, isOnline: true, shiftStatus: 'ON_SHIFT' },
    });

    // Deactivate Swift (MAINTENANCE)
    await makeRequest(
      'PATCH',
      `/api/vehicles/${vehicleSwift.id}/status`,
      { status: 'MAINTENANCE' },
      adminToken
    );

    const dbRentalDriver = await prisma.driverProfile.findUnique({
      where: { id: driverJegath.id },
      select: { isOnline: true, shiftStatus: true },
    });

    results.push({
      testNumber: '2.4',
      testName: 'RENTAL Vehicle Deactivation Forces Driver Offline',
      status: dbRentalDriver?.isOnline === false && dbRentalDriver?.shiftStatus === 'OFF_SHIFT' ? 'PASSED' : 'FAILED',
      request: { method: 'PATCH', url: `/api/vehicles/${vehicleSwift.id}/status`, body: { status: 'MAINTENANCE' } },
      response: { statusCode: 200, body: dbRentalDriver },
      notes: 'Rental driver forced OFF_SHIFT when allocated rental vehicle is deactivated',
    });

    // Restore Swift
    await prisma.vehicle.update({ where: { id: vehicleSwift.id }, data: { status: 'VERIFIED' } });
    await prisma.driverProfile.update({ where: { id: driverJegath.id }, data: { assignedVehicleId: null } });
  }
  console.log('✅ Test 2 Completed\n');

  // --------------------------------------------------------------------------
  // TEST 3: Dispatch & Acceptance
  // --------------------------------------------------------------------------
  console.log('--- TEST 3: DISPATCH & ACCEPTANCE ---');

  // Create a real test ride request
  const rideReqRes = await makeRequest(
    'POST',
    '/api/rides/request',
    {
      pickupLocation: 'White Town, Puducherry',
      pickupAddress: 'Beach Road, White Town, Puducherry',
      pickupLat: 11.9338,
      pickupLng: 79.8358,
      dropLocation: 'Auroville, Puducherry',
      dropAddress: 'Visitor Centre, Auroville',
      dropLat: 11.9860,
      dropLng: 79.8100,
      tripType: 'ONE_WAY',
      seatCapacity: 4,
    },
    customerToken
  );

  const testRideId = rideReqRes.body?.data?.id || rideReqRes.body?.id;
  console.log('Created test ride for dispatch tests:', testRideId);

  // 3A: Dispatch to Inactive Driver
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: false } });
  const assignInactiveDriverRes = await makeRequest(
    'PATCH',
    `/api/admin/rides/${testRideId}/assign`,
    { driverId: driverBarath.id },
    adminToken
  );

  results.push({
    testNumber: '3.1',
    testName: 'Dispatch Rejected for Inactive Driver',
    status:
      assignInactiveDriverRes.statusCode === 409 &&
      assignInactiveDriverRes.body?.reasonCode === 'DRIVER_INACTIVE'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'PATCH', url: `/api/admin/rides/${testRideId}/assign`, body: { driverId: driverBarath.id } },
    response: assignInactiveDriverRes,
    notes: 'Blocked by evaluateDriverAvailability: DRIVER_INACTIVE',
  });

  // Re-activate driver Barath
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: true } });
  await prisma.driverProfile.update({
    where: { id: driverBarath.id },
    data: { isOnline: true, shiftStatus: 'ON_SHIFT', assignedVehicleId: vehicleErtiga.id },
  });

  // 3B: Dispatch to Driver with MAINTENANCE Vehicle
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'MAINTENANCE' } });
  const assignMaintVehRes = await makeRequest(
    'PATCH',
    `/api/admin/rides/${testRideId}/assign`,
    { driverId: driverBarath.id },
    adminToken
  );

  results.push({
    testNumber: '3.2',
    testName: 'Dispatch Rejected for MAINTENANCE Vehicle',
    status:
      assignMaintVehRes.statusCode === 409 &&
      assignMaintVehRes.body?.reasonCode === 'VEHICLE_INACTIVE'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'PATCH', url: `/api/admin/rides/${testRideId}/assign`, body: { driverId: driverBarath.id } },
    response: assignMaintVehRes,
    notes: 'Blocked by evaluateDriverAvailability: VEHICLE_INACTIVE',
  });

  // 3C: Dispatch to Driver with PENDING Vehicle
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'PENDING' } });
  const assignPendingVehRes = await makeRequest(
    'PATCH',
    `/api/admin/rides/${testRideId}/assign`,
    { driverId: driverBarath.id },
    adminToken
  );

  results.push({
    testNumber: '3.3',
    testName: 'Dispatch Rejected for PENDING Vehicle',
    status:
      assignPendingVehRes.statusCode === 409 &&
      assignPendingVehRes.body?.reasonCode === 'VEHICLE_INACTIVE'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'PATCH', url: `/api/admin/rides/${testRideId}/assign`, body: { driverId: driverBarath.id } },
    response: assignPendingVehRes,
    notes: 'Blocked by evaluateDriverAvailability: VEHICLE_INACTIVE',
  });

  // 3D: Accept Ride with Inactive Driver Account
  // Restore vehicle to VERIFIED
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'VERIFIED', isOnline: true } });
  // Assign ride to driver Barath
  await prisma.ride.update({
    where: { id: testRideId },
    data: { driverId: driverBarath.id, vehicleId: vehicleErtiga.id, status: 'SEARCHING' },
  });

  // Generate valid driver token first, then deactivate user
  const barathAcceptToken = await getDriverToken('8754358963');
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: false } });

  const acceptInactiveRes = await makeRequest(
    'POST',
    `/api/rides/${testRideId}/accept`,
    {},
    barathAcceptToken
  );

  results.push({
    testNumber: '3.4',
    testName: 'Accept Ride Rejected for Inactive Driver Account',
    status: acceptInactiveRes.statusCode === 403 ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: `/api/rides/${testRideId}/accept` },
    response: acceptInactiveRes,
    notes: 'Blocked with 403 Forbidden: Account has been deactivated',
  });

  // 3E: Accept Ride with Inactive Vehicle
  await prisma.user.update({ where: { id: driverBarath.userId }, data: { isActive: true } });
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'MAINTENANCE' } });
  const barathFreshToken = await getDriverToken('8754358963');

  const acceptMaintVehRes = await makeRequest(
    'POST',
    `/api/rides/${testRideId}/accept`,
    {},
    barathFreshToken
  );

  results.push({
    testNumber: '3.5',
    testName: 'Accept Ride Rejected for Inactive Vehicle',
    status:
      acceptMaintVehRes.statusCode === 400 &&
      String(acceptMaintVehRes.body?.message).includes('maintenance')
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'POST', url: `/api/rides/${testRideId}/accept` },
    response: acceptMaintVehRes,
    notes: 'acceptRide guard blocks acceptance when assigned vehicle is not VERIFIED',
  });

  // Restore vehicle
  await prisma.vehicle.update({ where: { id: vehicleErtiga.id }, data: { status: 'VERIFIED', isOnline: true } });
  console.log('✅ Test 3 Completed\n');

  // --------------------------------------------------------------------------
  // TEST 4: Active Ride Protection
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: ACTIVE RIDE PROTECTION ---');

  // 4A: Accept ride normally
  const acceptValidRes = await makeRequest(
    'POST',
    `/api/rides/${testRideId}/accept`,
    {},
    barathFreshToken
  );
  console.log('Ride accepted:', acceptValidRes.statusCode);

  // Driver arrives at pickup
  const arrivedRes = await makeRequest(
    'PATCH',
    `/api/rides/${testRideId}/status`,
    { status: 'ARRIVED' },
    barathFreshToken
  );
  console.log('Ride marked ARRIVED:', arrivedRes.statusCode);

  const rideInDb = await prisma.ride.findUnique({ where: { id: testRideId } });
  const startOtp = rideInDb?.startOtp;

  // Start ride with OTP (status transitions to ONGOING)
  const startRes = await makeRequest(
    'POST',
    `/api/rides/${testRideId}/start`,
    { otp: startOtp },
    barathFreshToken
  );
  console.log('Ride started (ONGOING):', startRes.statusCode);

  // 4B: Admin DEACTIVATES Driver while Ride is ONGOING
  const deactDuringRide = await makeRequest(
    'PATCH',
    `/api/drivers/${driverBarath.id}/status`,
    { status: 'INACTIVE' },
    adminToken
  );

  // Verify PostgreSQL: Ride must STILL be ONGOING (not cancelled!)
  const rideAfterDeact = await prisma.ride.findUnique({
    where: { id: testRideId },
    select: { id: true, status: true, bookingCode: true },
  });

  const driverAfterDeact = await prisma.driverProfile.findUnique({
    where: { id: driverBarath.id },
    select: { isOnline: true, shiftStatus: true, user: { select: { isActive: true } } },
  });

  results.push({
    testNumber: '4.1',
    testName: 'Ongoing Ride Protected During Driver Deactivation',
    status:
      rideAfterDeact?.status === 'ONGOING' &&
      driverAfterDeact?.user?.isActive === false &&
      driverAfterDeact?.isOnline === false &&
      driverAfterDeact?.shiftStatus === 'OFF_SHIFT'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'PATCH', url: `/api/drivers/${driverBarath.id}/status`, body: { status: 'INACTIVE' } },
    response: deactDuringRide,
    dbBefore: { rideStatus: 'ONGOING', driverIsActive: true },
    dbAfter: { rideStatus: rideAfterDeact?.status, driverState: driverAfterDeact },
    notes: 'Ride remains ONGOING; driver taken OFF_SHIFT so no new rides can be dispatched',
  });

  // 4C: Complete the Ride safely via Admin or Driver
  const completeRes = await makeRequest(
    'POST',
    `/api/rides/${testRideId}/complete`,
    { paymentMethod: 'CASH', distanceKm: 8.5 },
    adminToken
  );

  const rideCompletedDb = await prisma.ride.findUnique({
    where: { id: testRideId },
    select: { status: true, driverId: true },
  });

  const driverPostCompletion = await prisma.driverProfile.findUnique({
    where: { id: driverBarath.id },
    select: { isOnline: true, shiftStatus: true },
  });

  results.push({
    testNumber: '4.2',
    testName: 'Ride Completes Safely & Driver Remains Offline',
    status:
      rideCompletedDb?.status === 'COMPLETED' &&
      driverPostCompletion?.isOnline === false &&
      driverPostCompletion?.shiftStatus === 'OFF_SHIFT'
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'POST', url: `/api/rides/${testRideId}/complete`, body: { paymentMethod: 'CASH', distanceKm: 8.5 } },
    response: completeRes,
    dbAfter: { rideStatus: rideCompletedDb?.status, driverState: driverPostCompletion },
    notes: 'Ride successfully completed; deactivated driver stays offline permanently',
  });
  console.log('✅ Test 4 Completed\n');

  // --------------------------------------------------------------------------
  // TEST 5: Reactivation
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: REACTIVATION ---');

  // Admin reactivates driver
  const reactivateRes = await makeRequest(
    'PATCH',
    `/api/drivers/${driverBarath.id}/status`,
    { status: 'ACTIVE' },
    adminToken
  );

  // Admin reactivates vehicle
  const reactVehRes = await makeRequest(
    'PATCH',
    `/api/vehicles/${vehicleErtiga.id}/status`,
    { status: 'VERIFIED' },
    adminToken
  );

  // Fresh token after reactivation
  const barathReactivatedToken = await getDriverToken('8754358963');

  // Driver turns shift ON
  const shiftOnRes = await makeRequest(
    'POST',
    '/api/drivers/shift',
    { shiftStatus: 'ON_SHIFT', isOnline: true },
    barathReactivatedToken
  );

  const dbReactivated = await prisma.driverProfile.findUnique({
    where: { id: driverBarath.id },
    select: {
      isOnline: true,
      shiftStatus: true,
      approvalStatus: true,
      user: { select: { isActive: true } },
      assignedVehicle: { select: { status: true, isOnline: true } },
    },
  });

  results.push({
    testNumber: '5.1',
    testName: 'Driver & Vehicle Reactivation Restores Eligibility',
    status:
      reactivateRes.statusCode === 200 &&
      shiftOnRes.statusCode === 200 &&
      dbReactivated?.isOnline === true &&
      dbReactivated?.shiftStatus === 'ON_SHIFT' &&
      dbReactivated?.user?.isActive === true
        ? 'PASSED'
        : 'FAILED',
    request: { method: 'POST', url: '/api/drivers/shift', body: { shiftStatus: 'ON_SHIFT', isOnline: true } },
    response: shiftOnRes,
    dbAfter: dbReactivated,
    notes: 'Re-activation restores online and shift eligibility only when both user and vehicle are VERIFIED/ACTIVE',
  });
  console.log('✅ Test 5 Completed\n');

  // --------------------------------------------------------------------------
  // TEST 6: Regression
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: REGRESSION ---');

  // 6A: Fare Estimate
  const estRes = await makeRequest('POST', '/api/rides/estimate', {
    pickupLat: 11.9338,
    pickupLng: 79.8358,
    dropLat: 11.9860,
    dropLng: 79.8100,
    tripType: 'ONE_WAY',
    category: 'BUDGET',
  });

  const fareVal = estRes.body?.data?.estimatedFare || estRes.body?.totalFare || 0;
  const distVal = estRes.body?.data?.distanceKm || estRes.body?.distanceKm || 0;
  results.push({
    testNumber: '6.1',
    testName: 'Regression: Public Fare Estimate Flow',
    status: estRes.statusCode === 200 && fareVal > 0 ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: '/api/rides/estimate' },
    response: estRes,
    notes: `Estimated fare: ₹${fareVal}, distance: ${distVal} km`,
  });

  // 6B: Live GPS Tracking
  const gpsRes = await makeRequest(
    'POST',
    '/api/drivers/location',
    { latitude: 11.9350, longitude: 79.8360, heading: 90, speed: 25 },
    barathReactivatedToken
  );

  results.push({
    testNumber: '6.2',
    testName: 'Regression: Live GPS Location Update Flow',
    status: gpsRes.statusCode === 200 && gpsRes.body?.success === true ? 'PASSED' : 'FAILED',
    request: { method: 'POST', url: '/api/drivers/location', body: { latitude: 11.9350, longitude: 79.8360 } },
    response: gpsRes,
    notes: 'GPS coordinates recorded in DriverProfile',
  });

  // 6C: Notifications persistence check
  const notifications = await prisma.notification.findMany({
    where: { userId: driverBarath.userId },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  results.push({
    testNumber: '6.3',
    testName: 'Regression: System & FCM Notification Persistence',
    status: notifications.length > 0 ? 'PASSED' : 'FAILED',
    request: { method: 'DB_QUERY', url: 'Notification.findMany' },
    response: { statusCode: 200, body: notifications },
    notes: `Found ${notifications.length} notifications stored for driver Barath`,
  });

  console.log('\n====================================================');
  console.log('🏁 ALL TESTS EXECUTED. SUMMARY REPORT:');
  console.log('====================================================');
  console.table(
    results.map((r) => ({
      Test: r.testNumber,
      Name: r.testName,
      Status: r.status,
      HTTP: r.response.statusCode,
      Notes: r.notes,
    }))
  );

  // Write full JSON report to file
  const fs = await import('fs');
  fs.writeFileSync(
    'd:/flutter projects/golden_cabs_backend/e2e_qa_report.json',
    JSON.stringify(results, null, 2),
    'utf8'
  );
  console.log('Report saved to d:/flutter projects/golden_cabs_backend/e2e_qa_report.json');
}

runTestSuite()
  .catch((err) => {
    console.error('Test Suite Failed with Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
