import http from 'http';

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://127.0.0.1:3000');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('=== 1. AUDIT LOGIN APIS ===');

  // Customer Send OTP
  const sendOtpRes = await request('POST', '/api/auth/send-otp', { phone: '9876543210' });
  console.log('Customer Send OTP Status:', sendOtpRes.status, sendOtpRes.body?.message);
  const otp = sendOtpRes.body?.devOtp || '123456';
  console.log('Using OTP:', otp);

  // Customer Verify OTP
  const verifyOtpRes = await request('POST', '/api/auth/verify-otp', {
    phone: '9876543210',
    otp: otp,
    role: 'CUSTOMER'
  });
  console.log('Customer Verify OTP Status:', verifyOtpRes.status);
  const customerToken = verifyOtpRes.body?.data?.token;
  const customerUser = verifyOtpRes.body?.data?.user;
  console.log('Customer JWT Acquired:', !!customerToken, 'User ID:', customerUser?.id);

  // Admin Login
  const adminLoginRes = await request('POST', '/api/auth/admin-login', {
    identifier: 'admin@goldencabs.com',
    password: 'admin123'
  });
  console.log('Admin Login Status:', adminLoginRes.status);
  const adminToken = adminLoginRes.body?.data?.token;
  console.log('Admin JWT Acquired:', !!adminToken);

  // Driver Login
  const driverLoginRes = await request('POST', '/api/auth/driver-login', {
    phone: '9876543220',
    password: 'password123',
    personaType: 'DRIVE_ONLY'
  });
  console.log('Driver Login Status:', driverLoginRes.status);
  const driverToken = driverLoginRes.body?.data?.token;
  const driverProfile = driverLoginRes.body?.data?.driverProfile;
  console.log('Driver JWT Acquired:', !!driverToken, 'Driver Profile ID:', driverProfile?.id);

  console.log('\n=== 2. AUDIT RIDE REQUEST API (Customer -> Backend & PostgreSQL) ===');
  const rideRequestRes = await request('POST', '/api/rides/request', {
    pickupLocation: 'Pondy New Bus Stand',
    pickupAddress: 'Maraimalai Adigal Salai, Pondicherry',
    pickupLat: 11.9360,
    pickupLng: 79.8174,
    dropLocation: 'Lawspet Airport',
    dropAddress: 'Airport Road, Lawspet, Pondicherry',
    dropLat: 11.9680,
    dropLng: 79.8105,
    tripType: 'ONE_WAY',
    category: 'BUDGET',
    paymentMethod: 'CASH'
  }, customerToken);

  console.log('Customer Ride Request Status:', rideRequestRes.status);
  const createdRide = rideRequestRes.body?.data;
  console.log('Created Ride in DB:');
  console.log('- UUID:', createdRide?.id);
  console.log('- Booking Code:', createdRide?.bookingCode);
  console.log('- DB Status:', createdRide?.status);
  console.log('- Start OTP:', createdRide?.startOtp);

  console.log('\n=== 3. AUDIT ADMIN INTEGRATION (Admin Dashboard & Assign) ===');
  const adminRidesRes = await request('GET', '/api/admin/rides', null, adminToken);
  console.log('Admin Get Rides Status:', adminRidesRes.status);
  const adminRides = adminRidesRes.body?.data || [];
  const foundRideInAdmin = adminRides.find(r => r.id === createdRide?.id || r.bookingId === createdRide?.bookingCode);
  console.log('Admin sees new ride:', !!foundRideInAdmin);
  console.log('- Display Status:', foundRideInAdmin?.status);
  console.log('- Matching Fare:', foundRideInAdmin?.fare);

  // Admin assigns driver
  const assignRes = await request('PATCH', `/api/admin/rides/${createdRide?.id}/assign`, {
    driverId: driverProfile?.id,
    vehicleId: driverProfile?.assignedVehicleId
  }, adminToken);
  console.log('Admin Assign Ride Status:', assignRes.status);
  console.log('- Assigned Driver ID in DB:', assignRes.body?.data?.driverId);

  console.log('\n=== 4. AUDIT DRIVER INTEGRATION (Available List & Accept) ===');
  const availableRidesRes = await request('GET', '/api/rides/available', null, driverToken);
  console.log('Driver Available Rides Status:', availableRidesRes.status);
  const availableRides = availableRidesRes.body?.data || [];
  const matchedDriverRide = availableRides.find(r => r.id === createdRide?.id || r.bookingCode === createdRide?.bookingCode);
  console.log('Assigned Ride Available to Driver:', !!matchedDriverRide);

  // Driver Accepts Ride
  const acceptRes = await request('POST', `/api/rides/${createdRide?.id}/accept`, {}, driverToken);
  console.log('Driver Accept Status:', acceptRes.status, 'Body:', acceptRes.body?.message);
  console.log('- Post-Accept DB Status:', acceptRes.body?.data?.status);
  console.log('- Driver ID on Ride:', acceptRes.body?.data?.driverId);

  // Driver Arrived
  const arrivedRes = await request('PATCH', `/api/rides/${createdRide?.id}/status`, { status: 'ARRIVED' }, driverToken);
  console.log('Driver ARRIVED Status:', arrivedRes.status, '- DB Status:', arrivedRes.body?.data?.status);

  // Driver Starts Trip with OTP
  const startRes = await request('POST', `/api/rides/${createdRide?.id}/start`, { otp: createdRide?.startOtp }, driverToken);
  console.log('Driver START Trip with OTP Status:', startRes.status, '- DB Status:', startRes.body?.data?.status);

  // Driver Completes Trip
  const completeRes = await request('POST', `/api/rides/${createdRide?.id}/complete`, {}, driverToken);
  console.log('Driver COMPLETE Trip Status:', completeRes.status, '- DB Status:', completeRes.body?.data?.status);
  console.log('- Final Fare:', completeRes.body?.data?.finalFare);

  console.log('\n=== FULL E2E AUDIT COMPLETE ===');
}

run().catch(console.error);
