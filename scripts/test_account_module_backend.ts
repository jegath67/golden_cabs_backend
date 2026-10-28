import http from 'http';

function request(options: {
  method: string;
  path: string;
  token?: string;
  body?: any;
}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, 'http://127.0.0.1:3000');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const req = http.request(
      url,
      { method: options.method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 500, body: { raw: data } });
          }
        });
      }
    );

    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Backend Integration Tests for Account Module ---');
  let passCount = 0;
  let failCount = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`[PASS] ${msg}`);
      passCount++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failCount++;
    }
  }

  // 1. Login with Driver 1 (DRIVE_ONLY)
  console.log('\n--- 1. Testing Driver 1 (9944256455) Auth & Profile ---');
  await request({
    method: 'POST',
    path: '/api/auth/send-otp',
    body: { phone: '9944256455', intent: 'LOGIN' },
  });
  const loginRes1 = await request({
    method: 'POST',
    path: '/api/auth/verify-otp',
    body: { phone: '9944256455', otp: '123456', role: 'DRIVER' },
  });
  assert(loginRes1.status === 200, 'Driver 1 OTP login succeeded (200)');
  const token1 = loginRes1.body?.data?.token;
  assert(!!token1, 'Driver 1 received valid JWT token');

  // 2. Test GET /api/drivers/me returns driverCode
  const meRes1 = await request({
    method: 'GET',
    path: '/api/drivers/me',
    token: token1,
  });
  assert(meRes1.status === 200, 'GET /api/drivers/me returns 200');
  const driverData1 = meRes1.body?.data;
  assert(!!driverData1?.driverCode, `Driver 1 has driverCode: "${driverData1?.driverCode}"`);
  assert(
    typeof driverData1?.driverCode === 'string' && driverData1.driverCode.startsWith('DRV-'),
    `driverCode starts with DRV- (Actual: ${driverData1?.driverCode})`
  );
  const initialApprovalStatus = driverData1?.approvalStatus;

  // 3. Test PATCH /api/drivers/profile updates name/email and does NOT reset approvalStatus
  console.log('\n--- 2. Testing PATCH /api/drivers/profile ---');
  const testName = `Updated Driver ${Date.now().toString().slice(-4)}`;
  const testEmail = `driver_${Date.now().toString().slice(-4)}@goldencabs.test`;
  const updateProfileRes = await request({
    method: 'PATCH',
    path: '/api/drivers/profile',
    token: token1,
    body: { name: testName, email: testEmail },
  });
  assert(updateProfileRes.status === 200, 'PATCH /api/drivers/profile returns 200');
  assert(updateProfileRes.body?.data?.user?.name === testName, 'Profile name updated on server');
  assert(updateProfileRes.body?.data?.user?.email === testEmail, 'Profile email updated on server');

  // Verify GET /api/drivers/me preserves approvalStatus
  const meResAfterUpdate = await request({
    method: 'GET',
    path: '/api/drivers/me',
    token: token1,
  });
  const updatedDriver = meResAfterUpdate.body?.data;
  assert(
    updatedDriver?.approvalStatus === initialApprovalStatus,
    `approvalStatus remained "${initialApprovalStatus}" (NOT reset to PENDING)`
  );
  assert(updatedDriver?.user?.name === testName, 'Persisted name verified via GET /api/drivers/me');

  // 4. Test POST & GET /api/drivers/reports
  console.log('\n--- 3. Testing POST & GET /api/drivers/reports ---');
  const reportSubject = `Test Issue ${Date.now().toString().slice(-4)}`;
  const reportDesc = 'Testing live report submission and persistence';
  const postReportRes = await request({
    method: 'POST',
    path: '/api/drivers/reports',
    token: token1,
    body: { title: reportSubject, description: reportDesc },
  });
  assert(postReportRes.status === 201, 'POST /api/drivers/reports returns 201 Created');
  const createdReport = postReportRes.body?.data;
  assert(!!createdReport?.id, `Report created with ID: ${createdReport?.id}`);
  assert(createdReport?.title === reportSubject, 'Report title saved accurately');
  assert(createdReport?.status === 'In Progress' || createdReport?.status === 'OPEN', `Report status valid: ${createdReport?.status}`);

  // Retrieve reports for Driver 1
  const getReportsRes1 = await request({
    method: 'GET',
    path: '/api/drivers/reports',
    token: token1,
  });
  assert(getReportsRes1.status === 200, 'GET /api/drivers/reports returns 200');
  const reportsList1 = Array.isArray(getReportsRes1.body?.data) ? getReportsRes1.body.data : (getReportsRes1.body?.data?.reports || []);
  assert(reportsList1.length > 0, `Driver 1 reports fetched (count: ${reportsList1.length})`);
  const foundReport = reportsList1.find((r: any) => r.id === createdReport?.id);
  assert(!!foundReport, 'Newly created report found in Driver 1 report history');

  // 5. Test Driver 2 report isolation
  console.log('\n--- 4. Testing Multi-Tenant Report Isolation ---');
  await request({
    method: 'POST',
    path: '/api/auth/send-otp',
    body: { phone: '8754616494', intent: 'LOGIN' },
  });
  const loginRes2 = await request({
    method: 'POST',
    path: '/api/auth/verify-otp',
    body: { phone: '8754616494', otp: '123456', role: 'DRIVER' },
  });
  assert(loginRes2.status === 200, 'Driver 2 OTP login succeeded (200)');
  const token2 = loginRes2.body?.data?.token;

  const getReportsRes2 = await request({
    method: 'GET',
    path: '/api/drivers/reports',
    token: token2,
  });
  assert(getReportsRes2.status === 200, 'Driver 2 GET /api/drivers/reports returns 200');
  const reportsList2 = getReportsRes2.body?.data?.reports || [];
  const leakedReport = reportsList2.find((r: any) => r.id === createdReport.id);
  assert(!leakedReport, 'Driver 2 CANNOT see Driver 1 reports (Report isolation confirmed)');

  // 6. Test Vehicle Ownership and Isolation for DRIVER (RENTAL / Fleet Owner)
  console.log('\n--- 5. Testing Vehicle Management & Owner Isolation ---');
  // Driver 2 (8754616494 is RENTAL)
  const getVehiclesRes2 = await request({
    method: 'GET',
    path: '/api/vehicles',
    token: token2,
  });
  assert(getVehiclesRes2.status === 200, 'Driver 2 GET /api/vehicles returns 200');
  const driver2ProfileId = loginRes2.body?.data?.user?.driverProfile?.id;
  const vehicles2 = getVehiclesRes2.body?.data?.vehicles || [];
  const anyForeignVehicle = vehicles2.some((v: any) => v.ownerId && v.ownerId !== driver2ProfileId);
  assert(!anyForeignVehicle, 'Driver 2 only sees vehicles owned by self (or assigned), not entire system fleet');

  // Test Driver 1 (DRIVE_ONLY) cannot toggle availability of Driver 2's vehicle
  if (vehicles2.length > 0) {
    const targetVehicle = vehicles2[0];
    console.log(`Testing authorization guard on vehicle ID ${targetVehicle.id}...`);
    const toggleAttemptRes = await request({
      method: 'PATCH',
      path: `/api/vehicles/${targetVehicle.id}/availability`,
      token: token1, // Driver 1 attempting to tamper Driver 2's vehicle
      body: { isAvailable: false },
    });
    assert(
      toggleAttemptRes.status === 403,
      `Unauthorized driver rejected with 403 Forbidden on vehicle tampering (Status: ${toggleAttemptRes.status})`
    );
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log(`========================================\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
