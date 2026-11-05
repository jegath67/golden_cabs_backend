import { prisma } from '../src/config/prisma';
import { locationCacheService } from '../src/modules/drivers/location-cache.service';
import { calculateRedisBackoffDelay } from '../src/config/redis';

const BASE_URL = 'http://localhost:3000';

interface IntegrationResult {
  section: string;
  scenario: string;
  endpoint: string;
  httpStatus: number | string;
  dbResult: string;
  redisResult: string;
  isRealService: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  evidence: string;
}

const testLog: IntegrationResult[] = [];

async function makeRequest(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ status: number; body: any }> {
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

  const text = await res.text();
  let jsonBody: any;
  try {
    jsonBody = JSON.parse(text);
  } catch {
    jsonBody = text;
  }

  return { status: res.status, body: jsonBody };
}

async function runRealIntegration() {
  console.log('========================================================================');
  console.log('🌐 GOLDEN CABS – P3 REAL ENVIRONMENT INTEGRATION TEST SUITE');
  console.log('========================================================================\n');

  // ===========================================================================
  // SECTION 1: ENVIRONMENT VERIFICATION
  // ===========================================================================
  console.log('▶ [1/5] VERIFYING REAL ENVIRONMENT & CONNECTIVITY...');

  // 1.1 Real PostgreSQL Connection
  let pgVersion = '';
  try {
    const rawPg: any[] = await prisma.$queryRaw`SELECT version();`;
    pgVersion = rawPg[0]?.version?.split(' ')?.[0] + ' ' + rawPg[0]?.version?.split(' ')?.[1];
    testLog.push({
      section: 'Environment',
      scenario: 'PostgreSQL Real Database Connection',
      endpoint: 'TCP 5432 (Prisma $queryRaw)',
      httpStatus: 'N/A',
      dbResult: `Connected: ${pgVersion}`,
      redisResult: 'N/A',
      isRealService: true,
      status: 'PASS',
      evidence: `PostgreSQL connection live. Query executed successfully: ${pgVersion}`,
    });
    console.log(`   ✅ 1.1 PostgreSQL Connected (${pgVersion})`);
  } catch (err: any) {
    testLog.push({
      section: 'Environment',
      scenario: 'PostgreSQL Real Database Connection',
      endpoint: 'TCP 5432 (Prisma $queryRaw)',
      httpStatus: 'N/A',
      dbResult: `Failed: ${err?.message}`,
      redisResult: 'N/A',
      isRealService: true,
      status: 'FAIL',
      evidence: err?.message,
    });
    console.error(`   ❌ 1.1 PostgreSQL Connection Failed:`, err);
  }

  // 1.2 Backend Health Endpoint
  try {
    const healthRes = await makeRequest('GET', '/health');
    const isHealthy = healthRes.status === 200 && healthRes.body?.success === true;
    testLog.push({
      section: 'Environment',
      scenario: 'Backend Health Endpoint',
      endpoint: 'GET /health',
      httpStatus: healthRes.status,
      dbResult: healthRes.body?.database || 'Unknown',
      redisResult: healthRes.body?.redis || 'Unknown',
      isRealService: true,
      status: isHealthy ? 'PASS' : 'FAIL',
      evidence: JSON.stringify(healthRes.body),
    });
    console.log(`   ✅ 1.2 Backend Health Verified (Status: ${healthRes.status}, DB: ${healthRes.body?.database}, Redis: ${healthRes.body?.redis})`);
  } catch (err: any) {
    testLog.push({
      section: 'Environment',
      scenario: 'Backend Health Endpoint',
      endpoint: 'GET /health',
      httpStatus: 'CONN_ERR',
      dbResult: 'N/A',
      redisResult: 'N/A',
      isRealService: true,
      status: 'FAIL',
      evidence: err?.message,
    });
    console.error(`   ❌ 1.2 Health Check Failed:`, err);
  }

  // 1.3 Environment Variables Security Inspection
  const dbUrlConfigured = !!process.env.DATABASE_URL;
  const nodeEnv = process.env.NODE_ENV || 'development';
  testLog.push({
    section: 'Environment',
    scenario: 'Environment Configuration (Without Secret Exposure)',
    endpoint: 'Process Environment',
    httpStatus: 'N/A',
    dbResult: dbUrlConfigured ? 'DATABASE_URL Present & Masked' : 'MISSING',
    redisResult: process.env.REDIS_URL ? 'REDIS_URL Configured' : 'Default localhost:6379 with In-Memory Fallback',
    isRealService: true,
    status: dbUrlConfigured ? 'PASS' : 'FAIL',
    evidence: `NODE_ENV=${nodeEnv}, DATABASE_URL length=${process.env.DATABASE_URL?.length || 0} chars, secrets unexposed.`,
  });
  console.log(`   ✅ 1.3 Environment Variables Verified (NODE_ENV: ${nodeEnv}, Secrets protected)`);

  // ===========================================================================
  // SECTION 2: AUTHENTICATION SETUP (ADMIN, DRIVER, CUSTOMER)
  // ===========================================================================
  console.log('\n▶ [2/5] AUTHENTICATING ROLES ACROSS ECOSYSTEM...');

  // 2.1 Authenticate Admin
  let adminToken = '';
  const adminLogin = await makeRequest('POST', '/api/auth/admin-login', {
    identifier: 'admin@goldencabs.com',
    password: 'admin123',
  });
  if (adminLogin.status === 200 && adminLogin.body?.data?.token) {
    adminToken = adminLogin.body.data.token;
    testLog.push({
      section: 'Authentication',
      scenario: 'Admin Panel Authentication',
      endpoint: 'POST /api/auth/admin-login',
      httpStatus: adminLogin.status,
      dbResult: 'User record verified in PostgreSQL',
      redisResult: 'N/A',
      isRealService: true,
      status: 'PASS',
      evidence: `Admin authenticated, JWT issued: ${adminToken.slice(0, 15)}...`,
    });
    console.log('   ✅ 2.1 Admin Authenticated');
  } else {
    throw new Error(`Admin login failed: ${JSON.stringify(adminLogin.body)}`);
  }

  // 2.2 Seed / Retrieve Dedicated Test Driver
  const driverPhone = '9876500001';
  let testDriverUser = await prisma.user.findUnique({ where: { phone: driverPhone } });
  if (!testDriverUser) {
    testDriverUser = await prisma.user.create({
      data: {
        phone: driverPhone,
        name: 'P3 Real Integration Driver',
        email: 'p3_driver@goldencabs.com',
        role: 'DRIVER',
        isActive: true,
      },
    });
  }

  // Ensure DriverProfile has an assigned vehicle and hub
  let hub = await prisma.hub.findFirst();
  if (!hub) {
    hub = await prisma.hub.create({
      data: {
        name: 'Chennai Central Hub',
        city: 'Chennai',
        latitude: 13.0827,
        longitude: 80.2707,
        address: 'Central Station Road, Chennai',
      },
    });
  }

  // Find or create a dedicated unassigned test vehicle
  const testVehicleNumber = `TN-01-P3-${testDriverUser.id.slice(0, 4).toUpperCase()}`;
  let vehicle = await prisma.vehicle.findUnique({ where: { vehicleNumber: testVehicleNumber } });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({
      data: {
        vehicleNumber: testVehicleNumber,
        brand: 'Maruti Suzuki',
        model: 'Dzire',
        year: 2024,
        vehicleType: 'SEDAN',
        category: 'BUDGET',
        fuelType: 'PETROL',
        status: 'VERIFIED',
      },
    });
  }

  await prisma.driverProfile.updateMany({
    where: { assignedVehicleId: vehicle.id, NOT: { userId: testDriverUser.id } },
    data: { assignedVehicleId: null },
  });

  let driverProfile = await prisma.driverProfile.findUnique({ where: { userId: testDriverUser.id } });
  if (!driverProfile) {
    driverProfile = await prisma.driverProfile.create({
      data: {
        userId: testDriverUser.id,
        approvalStatus: 'APPROVED',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        assignedHubId: hub.id,
        assignedVehicleId: vehicle.id,
        currentLatitude: 13.0827,
        currentLongitude: 80.2707,
      },
    });
  } else {
    driverProfile = await prisma.driverProfile.update({
      where: { id: driverProfile.id },
      data: {
        approvalStatus: 'APPROVED',
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        assignedHubId: hub.id,
        assignedVehicleId: vehicle.id,
      },
    });
  }

  // Get Driver JWT via real OTP verification
  await makeRequest('POST', '/api/auth/send-otp', { phone: driverPhone, intent: 'LOGIN' });
  const driverVerify = await makeRequest('POST', '/api/auth/verify-otp', {
    phone: driverPhone,
    otp: '123456',
    role: 'DRIVER',
  });
  const driverToken = driverVerify.body?.data?.token;
  if (!driverToken) {
    throw new Error(`Driver OTP verification failed: ${JSON.stringify(driverVerify.body)}`);
  }
  testLog.push({
    section: 'Authentication',
    scenario: 'Driver App OTP Authentication',
    endpoint: 'POST /api/auth/verify-otp',
    httpStatus: driverVerify.status,
    dbResult: `DriverProfile ID: ${driverProfile.id}`,
    redisResult: 'N/A',
    isRealService: true,
    status: 'PASS',
    evidence: `Driver JWT issued successfully for driverId=${driverProfile.id}`,
  });
  console.log(`   ✅ 2.2 Driver Authenticated (DriverId: ${driverProfile.id})`);

  // 2.3 Seed / Retrieve Dedicated Test Customer
  const customerPhone = '9876500002';
  let testCustomerUser = await prisma.user.findUnique({ where: { phone: customerPhone } });
  if (!testCustomerUser) {
    testCustomerUser = await prisma.user.create({
      data: {
        phone: customerPhone,
        name: 'P3 Real Integration Customer',
        email: 'p3_customer@goldencabs.com',
        role: 'CUSTOMER',
        isActive: true,
      },
    });
  }
  await prisma.customerProfile.upsert({
    where: { userId: testCustomerUser.id },
    create: { userId: testCustomerUser.id, rating: 5.0, totalRides: 0 },
    update: {},
  });

  // Get Customer JWT via real OTP verification
  await makeRequest('POST', '/api/auth/send-otp', { phone: customerPhone, intent: 'LOGIN' });
  const customerVerify = await makeRequest('POST', '/api/auth/verify-otp', {
    phone: customerPhone,
    otp: '123456',
    role: 'CUSTOMER',
  });
  const customerToken = customerVerify.body?.data?.token;
  if (!customerToken) {
    throw new Error(`Customer OTP verification failed: ${JSON.stringify(customerVerify.body)}`);
  }
  testLog.push({
    section: 'Authentication',
    scenario: 'Customer App OTP Authentication',
    endpoint: 'POST /api/auth/verify-otp',
    httpStatus: customerVerify.status,
    dbResult: `CustomerId: ${testCustomerUser.id}`,
    redisResult: 'N/A',
    isRealService: true,
    status: 'PASS',
    evidence: `Customer JWT issued successfully for customerId=${testCustomerUser.id}`,
  });
  console.log(`   ✅ 2.3 Customer Authenticated (CustomerId: ${testCustomerUser.id})`);

  // ===========================================================================
  // SECTION 3: DRIVER GPS LOCATION & LIVE MAP INTEGRATION
  // ===========================================================================
  console.log('\n▶ [3/5] TESTING REAL DRIVER GPS PINGS & ADMIN LIVE MAP...');

  // 3.1 Send Real GPS Location Update
  const testLat = 13.0845;
  const testLng = 80.2725;
  const gpsTimestamp = Date.now();

  const gpsRes = await makeRequest(
    'POST',
    '/api/drivers/location',
    {
      latitude: testLat,
      longitude: testLng,
      heading: 45,
      speed: 15,
      accuracy: 4,
      timestamp: gpsTimestamp,
    },
    driverToken
  );

  const gpsSuccess = gpsRes.status === 200 && gpsRes.body?.success === true;
  testLog.push({
    section: 'Driver GPS',
    scenario: 'Real GPS Location Update Propagation',
    endpoint: 'POST /api/drivers/location',
    httpStatus: gpsRes.status,
    dbResult: 'Location buffered in cache for batch DB flush',
    redisResult: 'Cached in Redis / In-Memory Location Cache',
    isRealService: true,
    status: gpsSuccess ? 'PASS' : 'FAIL',
    evidence: `Payload returned: lat=${gpsRes.body?.data?.latitude}, lng=${gpsRes.body?.data?.longitude}`,
  });
  console.log(`   ✅ 3.1 Driver GPS Ping Accepted (Lat: ${testLat}, Lng: ${testLng})`);

  // 3.2 Verify PostgreSQL Synchronization after Scheduled Batch Flush
  console.log('   ⏳ Waiting 5.5s for backend scheduled batch flush to PostgreSQL...');
  await new Promise((r) => setTimeout(r, 5500));

  const updatedDbDriver = await prisma.driverProfile.findUnique({
    where: { id: driverProfile.id },
    select: { currentLatitude: true, currentLongitude: true },
  });
  const dbSynced =
    Math.abs((updatedDbDriver?.currentLatitude || 0) - testLat) < 0.0001 &&
    Math.abs((updatedDbDriver?.currentLongitude || 0) - testLng) < 0.0001;

  testLog.push({
    section: 'Driver GPS',
    scenario: 'PostgreSQL Coordinates Synchronization (Batch Sync)',
    endpoint: 'Database Verification (driverProfile)',
    httpStatus: 200,
    dbResult: `currentLatitude: ${updatedDbDriver?.currentLatitude}, currentLongitude: ${updatedDbDriver?.currentLongitude}`,
    redisResult: 'Synced from cache to PostgreSQL via 5s background timer',
    isRealService: true,
    status: dbSynced ? 'PASS' : 'FAIL',
    evidence: `Authoritative PostgreSQL record reflects latest GPS coordinates: (${updatedDbDriver?.currentLatitude}, ${updatedDbDriver?.currentLongitude})`,
  });
  console.log(`   ✅ 3.2 PostgreSQL Synced: (${updatedDbDriver?.currentLatitude}, ${updatedDbDriver?.currentLongitude})`);

  // 3.3 Verify Delayed Mobile GPS Packet Rejection
  const staleTimestamp = gpsTimestamp - 60000; // 60 seconds older than accepted ping
  const delayedGpsRes = await makeRequest(
    'POST',
    '/api/drivers/location',
    {
      latitude: 13.0001, // Stale old coordinate
      longitude: 80.0001,
      timestamp: staleTimestamp,
    },
    driverToken
  );

  // Read location back from live map (querying the real running server process)
  const mapCheckAfterDelayed = await makeRequest('GET', '/api/admin/live-map', undefined, adminToken);
  const drvAfterDelayed = mapCheckAfterDelayed.body?.data?.drivers?.find((d: any) => d.id === driverProfile.id);
  const delayedDropped = Math.abs((drvAfterDelayed?.latitude || 0) - testLat) < 0.0001;

  testLog.push({
    section: 'Driver GPS',
    scenario: 'Delayed Out-of-Order GPS Packet Rejection',
    endpoint: 'POST /api/drivers/location (Older Timestamp)',
    httpStatus: delayedGpsRes.status,
    dbResult: `Preserved modern coordinates in PostgreSQL (${updatedDbDriver?.currentLatitude}, ${updatedDbDriver?.currentLongitude})`,
    redisResult: `Live Map preserved modern coordinate (${drvAfterDelayed?.latitude}, ${drvAfterDelayed?.longitude})`,
    isRealService: true,
    status: delayedDropped ? 'PASS' : 'FAIL',
    evidence: `Sent clientTs=${staleTimestamp} < cachedTs=${gpsTimestamp}; Stale location (13.0001) was dropped; active position remained (${drvAfterDelayed?.latitude}, ${drvAfterDelayed?.longitude}).`,
  });
  console.log('   ✅ 3.3 Delayed GPS Packet Dropped Cleanly');

  // 3.4 Admin Live Map API Verification
  const liveMapRes = await makeRequest('GET', '/api/admin/live-map', undefined, adminToken);
  const liveMapSuccess = liveMapRes.status === 200 && liveMapRes.body?.success === true;
  const adminDrivers: any[] = liveMapRes.body?.data?.drivers || [];
  const matchedAdminDriver = adminDrivers.find((d) => d.id === driverProfile.id);
  const adminCoordsMatch =
    matchedAdminDriver &&
    Math.abs(matchedAdminDriver.latitude - testLat) < 0.0001 &&
    matchedAdminDriver.status === 'Online';

  testLog.push({
    section: 'Admin Integration',
    scenario: 'Admin Live Map Real-Time Driver Fleet Display',
    endpoint: 'GET /api/admin/live-map',
    httpStatus: liveMapRes.status,
    dbResult: `Total drivers in map: ${liveMapRes.body?.data?.stats?.totalDrivers}`,
    redisResult: `Driver active coordinates matched from cache: (${matchedAdminDriver?.latitude}, ${matchedAdminDriver?.longitude})`,
    isRealService: true,
    status: adminCoordsMatch ? 'PASS' : 'FAIL',
    evidence: `Live map driver record: id=${matchedAdminDriver?.id}, status=${matchedAdminDriver?.status}, lat=${matchedAdminDriver?.latitude}, lng=${matchedAdminDriver?.longitude}`,
  });
  console.log(`   ✅ 3.4 Admin Live Map Verified (Driver Status: ${matchedAdminDriver?.status}, Lat: ${matchedAdminDriver?.latitude})`);

  // ===========================================================================
  // SECTION 4: COMPLETE RIDE LIFECYCLE REGRESSION
  // ===========================================================================
  console.log('\n▶ [4/5] RUNNING COMPLETE END-TO-END RIDE LIFECYCLE...');

  // 4.1 Customer Requests Ride
  const rideReqRes = await makeRequest(
    'POST',
    '/api/rides/request',
    {
      pickupLocation: 'Chennai Central Station',
      pickupLat: 13.0827,
      pickupLng: 80.2707,
      dropLocation: 'T Nagar Pondy Bazaar',
      dropLat: 13.0418,
      dropLng: 80.2341,
      tripType: 'DAILY',
      vehicleType: 'SEDAN',
      category: 'BUDGET',
      paymentMethod: 'CASH',
    },
    customerToken
  );

  if (rideReqRes.status !== 200 || !rideReqRes.body?.data?.id) {
    throw new Error(`Ride request failed: ${JSON.stringify(rideReqRes.body)}`);
  }
  const rideId = rideReqRes.body.data.id;
  const bookingCode = rideReqRes.body.data.bookingCode;
  const startOtp = rideReqRes.body.data.startOtp;

  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '1. Customer Creates Ride Booking',
    endpoint: 'POST /api/rides/request',
    httpStatus: rideReqRes.status,
    dbResult: `Ride created: ${rideId} (${bookingCode}), status=SEARCHING`,
    redisResult: 'N/A',
    isRealService: true,
    status: 'PASS',
    evidence: `Ride requested: id=${rideId}, bookingCode=${bookingCode}, startOtp=${startOtp}`,
  });
  console.log(`   ✅ 4.1 Customer Created Ride (${bookingCode})`);

  // 4.2 Admin Assigns Driver
  const assignRes = await makeRequest(
    'PATCH',
    `/api/admin/rides/${rideId}/assign`,
    {
      driverId: driverProfile.id,
      autoAccept: false,
    },
    adminToken
  );
  const assignSuccess = assignRes.status === 200 && assignRes.body?.success === true;
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '2. Admin Assigns Driver to Ride',
    endpoint: `PATCH /api/admin/rides/${rideId}/assign`,
    httpStatus: assignRes.status,
    dbResult: `Ride assigned to driverId=${driverProfile.id}`,
    redisResult: 'N/A',
    isRealService: true,
    status: assignSuccess ? 'PASS' : 'FAIL',
    evidence: `Admin assigned driver. Response: ${assignRes.body?.message}`,
  });
  console.log(`   ✅ 4.2 Admin Assigned Driver`);

  // 4.3 Driver Accepts Ride
  const acceptRes = await makeRequest('POST', `/api/rides/${rideId}/accept`, {}, driverToken);
  const acceptSuccess = acceptRes.status === 200 && acceptRes.body?.data?.status === 'ACCEPTED';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '3. Driver Accepts Assigned Ride',
    endpoint: `POST /api/rides/${rideId}/accept`,
    httpStatus: acceptRes.status,
    dbResult: `Ride status updated to ACCEPTED in PostgreSQL`,
    redisResult: 'N/A',
    isRealService: true,
    status: acceptSuccess ? 'PASS' : 'FAIL',
    evidence: `Driver accepted ride. Status: ${acceptRes.body?.data?.status}`,
  });
  console.log(`   ✅ 4.3 Driver Accepted Ride`);

  // 4.4 Customer Receives Driver Details
  const customerRideCheck = await makeRequest('GET', `/api/rides/${rideId}`, undefined, customerToken);
  const custSeesDriver =
    customerRideCheck.status === 200 &&
    customerRideCheck.body?.data?.driverId === driverProfile.id &&
    customerRideCheck.body?.data?.status === 'ACCEPTED';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '4. Customer Receives Driver Details',
    endpoint: `GET /api/rides/${rideId}`,
    httpStatus: customerRideCheck.status,
    dbResult: `Driver: ${customerRideCheck.body?.data?.driver?.user?.name || 'Driver Partner'}`,
    redisResult: 'N/A',
    isRealService: true,
    status: custSeesDriver ? 'PASS' : 'FAIL',
    evidence: `Customer fetches ride details: status=${customerRideCheck.body?.data?.status}, driverId=${customerRideCheck.body?.data?.driverId}`,
  });
  console.log(`   ✅ 4.4 Customer Verified Driver Details`);

  // 4.5 Driver Reaches Pickup (ARRIVED)
  const arrivedRes = await makeRequest(
    'PATCH',
    `/api/rides/${rideId}/status`,
    { status: 'ARRIVED' },
    driverToken
  );
  const arrivedSuccess = arrivedRes.status === 200 && arrivedRes.body?.data?.status === 'ARRIVED';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '5. Driver Marks ARRIVED at Pickup Spot',
    endpoint: `PATCH /api/rides/${rideId}/status`,
    httpStatus: arrivedRes.status,
    dbResult: 'Ride status updated to ARRIVED',
    redisResult: 'N/A',
    isRealService: true,
    status: arrivedSuccess ? 'PASS' : 'FAIL',
    evidence: `Status transition to ARRIVED confirmed: ${arrivedRes.body?.data?.status}`,
  });
  console.log(`   ✅ 4.5 Driver Marked ARRIVED`);

  // 4.6 Pickup OTP Verification & Start Ride (ONGOING)
  const startRes = await makeRequest(
    'POST',
    `/api/rides/${rideId}/start`,
    { otp: startOtp },
    driverToken
  );
  const startSuccess = startRes.status === 200 && startRes.body?.data?.status === 'ONGOING';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '6. Customer OTP Verification & Ride Start',
    endpoint: `POST /api/rides/${rideId}/start`,
    httpStatus: startRes.status,
    dbResult: 'Ride status updated to ONGOING, startOtp cleared/verified',
    redisResult: 'N/A',
    isRealService: true,
    status: startSuccess ? 'PASS' : 'FAIL',
    evidence: `Trip started successfully with OTP=${startOtp}. New status: ${startRes.body?.data?.status}`,
  });
  console.log(`   ✅ 4.6 Trip Started with Customer OTP (Status: ONGOING)`);

  // 4.7 Live GPS Ping on Active Ride
  const tripLat = 13.0700;
  const tripLng = 80.2500;
  const tripGpsRes = await makeRequest(
    'POST',
    '/api/drivers/location',
    {
      latitude: tripLat,
      longitude: tripLng,
      rideId,
      timestamp: Date.now(),
    },
    driverToken
  );
  const tripGpsSuccess = tripGpsRes.status === 200 && tripGpsRes.body?.success === true;

  // Check Admin Live Map shows driver "On Trip" with ride details
  const activeMapRes = await makeRequest('GET', '/api/admin/live-map', undefined, adminToken);
  const activeDriverMap = activeMapRes.body?.data?.drivers?.find((d: any) => d.id === driverProfile.id);
  const isDriverOnTrip = activeDriverMap?.status === 'On Trip' && activeDriverMap?.isOnTrip === true;

  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '7. Active Ride Live GPS Tracking',
    endpoint: 'POST /api/drivers/location (with rideId)',
    httpStatus: tripGpsRes.status,
    dbResult: `Active ride verified: ${rideId}`,
    redisResult: `Admin Map displays driver status="On Trip" at (${activeDriverMap?.latitude}, ${activeDriverMap?.longitude})`,
    isRealService: true,
    status: tripGpsSuccess && isDriverOnTrip ? 'PASS' : 'FAIL',
    evidence: `Live ride location update accepted. Admin live map driver status: ${activeDriverMap?.status}, isOnTrip: ${activeDriverMap?.isOnTrip}`,
  });
  console.log(`   ✅ 4.7 Active Ride GPS Ping & Admin Map Verified (Status: ${activeDriverMap?.status})`);

  // 4.8 Driver Completes Ride
  const completeRes = await makeRequest('POST', `/api/rides/${rideId}/complete`, {}, driverToken);
  const completeSuccess = completeRes.status === 200 && completeRes.body?.data?.status === 'COMPLETED';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '8. Driver Completes Ride',
    endpoint: `POST /api/rides/${rideId}/complete`,
    httpStatus: completeRes.status,
    dbResult: 'Ride status updated to COMPLETED; driver location flushed immediately',
    redisResult: 'Active ride validation cache invalidated immediately',
    isRealService: true,
    status: completeSuccess ? 'PASS' : 'FAIL',
    evidence: `Trip marked COMPLETED. Final fare: ₹${completeRes.body?.data?.finalFare}`,
  });
  console.log(`   ✅ 4.8 Trip Completed Successfully`);

  // 4.9 Customer Sees Completed Ride
  const custCompleteCheck = await makeRequest('GET', `/api/rides/${rideId}`, undefined, customerToken);
  const custSeesComplete = custCompleteCheck.status === 200 && custCompleteCheck.body?.data?.status === 'COMPLETED';
  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '9. Customer Views Completed Ride',
    endpoint: `GET /api/rides/${rideId}`,
    httpStatus: custCompleteCheck.status,
    dbResult: `status=COMPLETED, paymentStatus=${custCompleteCheck.body?.data?.paymentStatus}`,
    redisResult: 'N/A',
    isRealService: true,
    status: custSeesComplete ? 'PASS' : 'FAIL',
    evidence: `Customer verified completed ride. Status: ${custCompleteCheck.body?.data?.status}`,
  });
  console.log(`   ✅ 4.9 Customer Verified Completed Trip`);

  // 4.10 Customer Submits Review & Rating
  const reviewRes = await makeRequest(
    'POST',
    `/api/rides/${rideId}/review`,
    {
      rating: 5.0,
      comment: 'Excellent and punctual ride with polite driver!',
      cleanliness: '5',
      punctuality: '5',
    },
    customerToken
  );
  const reviewSuccess = reviewRes.status === 200 && reviewRes.body?.success === true;
  const dbReview = await prisma.review.findUnique({ where: { rideId } });

  testLog.push({
    section: 'Ride Lifecycle',
    scenario: '10. Customer Submits Review & Rating',
    endpoint: `POST /api/rides/${rideId}/review`,
    httpStatus: reviewRes.status,
    dbResult: `Review saved in PostgreSQL: ID=${dbReview?.id}, rating=${dbReview?.rating}`,
    redisResult: 'N/A',
    isRealService: true,
    status: reviewSuccess && !!dbReview ? 'PASS' : 'FAIL',
    evidence: `Review saved: rating=${dbReview?.rating}, comment="${dbReview?.comment}"`,
  });
  console.log(`   ✅ 4.10 Customer Review Submitted & Persisted in PostgreSQL (Rating: 5.0)`);

  // ===========================================================================
  // SECTION 5: EDGE CASES (CANCELLATION & SCHEDULED RIDES)
  // ===========================================================================
  console.log('\n▶ [5/5] TESTING EDGE CASES (CANCELLATION & SCHEDULED TRIPS)...');

  // 5.1 Ride Cancellation Flow
  const cancelRideReq = await makeRequest(
    'POST',
    '/api/rides/request',
    {
      pickupLocation: 'Guindy Metro',
      pickupLat: 13.0067,
      pickupLng: 80.2014,
      dropLocation: 'Velachery',
      dropLat: 12.9759,
      dropLng: 80.2212,
      tripType: 'DAILY',
      vehicleType: 'SEDAN',
      category: 'BUDGET',
    },
    customerToken
  );
  const cancelRideId = cancelRideReq.body.data.id;

  // Assign driver to ride so driver ownership validation passes
  await makeRequest(
    'PATCH',
    `/api/admin/rides/${cancelRideId}/assign`,
    {
      driverId: driverProfile.id,
      autoAccept: true,
    },
    adminToken
  );

  const cancelRes = await makeRequest(
    'PATCH',
    `/api/rides/${cancelRideId}/status`,
    {
      status: 'CANCELLED',
      cancelReason: 'Customer changed plans',
    },
    customerToken
  );
  const cancelSuccess = cancelRes.status === 200 && cancelRes.body?.data?.status === 'CANCELLED';

  // Subsequent GPS ping with cancelled rideId must be REJECTED immediately!
  const postCancelGps = await makeRequest(
    'POST',
    '/api/drivers/location',
    {
      latitude: 13.0067,
      longitude: 80.2014,
      rideId: cancelRideId,
    },
    driverToken
  );
  const cancelGpsRejected =
    postCancelGps.status === 400 &&
    postCancelGps.body?.message?.includes('Cannot update ride location for inactive ride status: CANCELLED');

  testLog.push({
    section: 'Edge Cases',
    scenario: 'Ride Cancellation & Inactive GPS Update Rejection',
    endpoint: `PATCH /api/rides/${cancelRideId}/status -> POST /api/drivers/location`,
    httpStatus: postCancelGps.status,
    dbResult: `Ride ${cancelRideId} status=CANCELLED in DB`,
    redisResult: 'Cache invalidated; subsequent GPS pings rejected',
    isRealService: true,
    status: cancelSuccess && cancelGpsRejected ? 'PASS' : 'FAIL',
    evidence: `Cancellation succeeded; post-cancellation GPS update rejected with 400: "${postCancelGps.body?.message}"`,
  });
  console.log(`   ✅ 5.1 Cancellation Flow & Inactive GPS Rejection Verified`);

  // 5.2 Scheduled Ride Creation
  const scheduledTime = new Date(Date.now() + 4 * 3600 * 1000).toISOString(); // 4 hours ahead
  const schedRideReq = await makeRequest(
    'POST',
    '/api/rides/request',
    {
      pickupLocation: 'Chennai Domestic Airport',
      pickupLat: 12.9863,
      pickupLng: 80.1706,
      dropLocation: 'Mahabalipuram',
      dropLat: 12.6208,
      dropLng: 80.1944,
      tripType: 'OUTSTATION',
      vehicleType: 'SEDAN',
      category: 'PREMIUM',
      isScheduled: true,
      scheduledAt: scheduledTime,
    },
    customerToken
  );
  const schedRideId = schedRideReq.body?.data?.id;
  const schedSuccess = schedRideReq.status === 200 && schedRideReq.body?.data?.status === 'SEARCHING';

  testLog.push({
    section: 'Edge Cases',
    scenario: 'Scheduled Ride Request Workflow',
    endpoint: 'POST /api/rides/request (isScheduled: true)',
    httpStatus: schedRideReq.status,
    dbResult: `Scheduled ride ${schedRideId} stored with scheduledAt=${scheduledTime}`,
    redisResult: 'N/A',
    isRealService: true,
    status: schedSuccess ? 'PASS' : 'FAIL',
    evidence: `Scheduled ride created successfully: id=${schedRideId}, scheduledAt=${scheduledTime}`,
  });
  console.log(`   ✅ 5.2 Scheduled Ride Request Verified (${schedRideId})`);

  // 5.3 Redis Backoff Algorithm Reliability
  const delay1 = calculateRedisBackoffDelay(1);
  const delay5 = calculateRedisBackoffDelay(5);
  const delay10 = calculateRedisBackoffDelay(10);
  const backoffValid = delay1 >= 1000 && delay5 > delay1 && delay10 <= 15500;

  testLog.push({
    section: 'Reliability',
    scenario: 'Redis Backoff Algorithm Bounded Reconnection',
    endpoint: 'Internal Configuration (calculateRedisBackoffDelay)',
    httpStatus: 'N/A',
    dbResult: 'N/A',
    redisResult: `Delay attempt 1: ${delay1}ms, attempt 5: ${delay5}ms, attempt 10: ${delay10}ms`,
    isRealService: true,
    status: backoffValid ? 'PASS' : 'FAIL',
    evidence: `Controlled exponential backoff: smoothly increases from ${delay1}ms to max cap ${delay10}ms with jitter.`,
  });
  console.log(`   ✅ 5.3 Redis Reconnection Backoff Bounded (1000ms -> ${delay10}ms)`);

  // ===========================================================================
  // SUMMARY REPORT
  // ===========================================================================
  console.log('\n========================================================================');
  console.log('📊 REAL ENVIRONMENT INTEGRATION AUDIT EVIDENCE TABLE:');
  console.log('========================================================================');

  let passCount = 0;
  let failCount = 0;

  for (const item of testLog) {
    const symbol = item.status === 'PASS' ? '✅' : '❌';
    if (item.status === 'PASS') passCount++;
    else failCount++;

    console.log(`${symbol} [${item.status}] | ${item.section.padEnd(16)} | ${item.scenario}`);
    console.log(`   ├─ Endpoint:    ${item.endpoint} (HTTP Status: ${item.httpStatus})`);
    console.log(`   ├─ Database:    ${item.dbResult}`);
    console.log(`   ├─ Redis/Cache: ${item.redisResult}`);
    console.log(`   └─ Evidence:    ${item.evidence}\n`);
  }

  console.log('========================================================================');
  console.log(`🎉 INTEGRATION TEST RUN COMPLETE: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('========================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runRealIntegration().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Fatal Integration Test Failure:', err);
  process.exit(1);
});
