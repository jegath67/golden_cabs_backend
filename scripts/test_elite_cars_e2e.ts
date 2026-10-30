import { prisma } from '../src/config/prisma';

const BASE_URL = 'http://localhost:3000';

async function testEliteCarsE2E() {
  console.log('====================================================');
  console.log('🏎️ TESTING ELITE CARS E2E ACROSS BACKEND & DATABASE');
  console.log('====================================================\n');

  let testCarId = '';

  try {
    // 1. GET ALL CARS
    console.log('--- 1. Fetch All Elite Cars ---');
    const getRes = await fetch(`${BASE_URL}/api/elite-cars`);
    const getData = await getRes.json();
    console.log(`HTTP Status: ${getRes.status}`);
    console.log(`Success: ${getData.success}`);
    console.log(`Initial Cars Count: ${getData.data.length}`);
    if (getData.data.length > 0) {
      console.log('Sample Car:', {
        brand: getData.data[0].brand,
        model: getData.data[0].model,
        category: getData.data[0].category,
        status: getData.data[0].status,
        pricePerKm: getData.data[0].pricePerKm,
        seats: getData.data[0].seats,
      });
    }

    // 2. CREATE A NEW ELITE CAR
    console.log('\n--- 2. Admin Creates New Elite Car (POST /api/elite-cars) ---');
    const newCarPayload = {
      brand: 'LAMBORGHINI',
      model: 'Lamborghini Urus Performante',
      category: 'Luxury',
      rating: 5.0,
      status: 'AVAILABLE',
      image: 'assets/images/all_vehicles/Ferrari-4.jpg',
      gallery: [
        'assets/images/all_vehicles/Ferrari-4.jpg',
        'assets/images/all_vehicles/Audi-Q7_1.jpg',
      ],
      speed: '306 km/h',
      seats: '5 Seats',
      features: 'Carbon Ceramic Brakes, Akrapovic Exhaust',
      price: '₹180/km',
      pricePerKm: 180.0,
      fuelType: 'Petrol',
      transmission: 'Automatic',
    };

    const createRes = await fetch(`${BASE_URL}/api/elite-cars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newCarPayload),
    });
    const createData = await createRes.json();
    console.log(`Create HTTP Status: ${createRes.status}`);
    console.log(`Created Car ID: ${createData.data?.id}`);
    testCarId = createData.data?.id;

    // Verify in PostgreSQL
    const dbCar = await prisma.eliteCar.findUnique({
      where: { id: testCarId },
    });
    console.log('PostgreSQL Record Verified:', {
      id: dbCar?.id,
      brand: dbCar?.brand,
      model: dbCar?.model,
      status: dbCar?.status,
      pricePerKm: dbCar?.pricePerKm,
    });

    if (!dbCar || dbCar.brand !== 'LAMBORGHINI') {
      throw new Error('Failed to verify created car in PostgreSQL!');
    }

    // 3. GET CAR BY ID
    console.log('\n--- 3. Fetch Car By ID (GET /api/elite-cars/:id) ---');
    const singleRes = await fetch(`${BASE_URL}/api/elite-cars/${testCarId}`);
    const singleData = await singleRes.json();
    console.log(`Fetch By ID Status: ${singleRes.status}`);
    console.log(`Model: ${singleData.data?.model}, Status: ${singleData.data?.status}`);

    // 4. UPDATE CAR
    console.log('\n--- 4. Update Elite Car Status & Pricing (PUT /api/elite-cars/:id) ---');
    const updatePayload = {
      status: 'MAINTENANCE',
      price: '₹200/km',
      pricePerKm: 200.0,
      features: 'Scheduled 10,000 km Service',
    };

    const updateRes = await fetch(`${BASE_URL}/api/elite-cars/${testCarId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatePayload),
    });
    const updateData = await updateRes.json();
    console.log(`Update HTTP Status: ${updateRes.status}`);
    console.log('Updated Status in Response:', updateData.data?.status);
    console.log('Updated Price in Response:', updateData.data?.pricePerKm);

    // Verify in DB
    const updatedDbCar = await prisma.eliteCar.findUnique({
      where: { id: testCarId },
    });
    console.log('PostgreSQL Record After Update:', {
      status: updatedDbCar?.status,
      pricePerKm: updatedDbCar?.pricePerKm,
      features: updatedDbCar?.features,
    });

    if (updatedDbCar?.status !== 'MAINTENANCE' || updatedDbCar?.pricePerKm !== 200.0) {
      throw new Error('Database does not match updated values!');
    }

    // 5. FILTER QUERY TEST (e.g. status=MAINTENANCE)
    console.log('\n--- 5. Test Filter Query (GET /api/elite-cars?status=MAINTENANCE) ---');
    const filterRes = await fetch(`${BASE_URL}/api/elite-cars?status=MAINTENANCE`);
    const filterData = await filterRes.json();
    console.log(`Filter Status 200, count: ${filterData.data.length}`);
    const foundUpdatedInFilter = filterData.data.some((c: any) => c.id === testCarId);
    console.log(`Found updated car in MAINTENANCE filter: ${foundUpdatedInFilter}`);

    // 6. DELETE CAR
    console.log('\n--- 6. Admin Deletes Elite Car (DELETE /api/elite-cars/:id) ---');
    const deleteRes = await fetch(`${BASE_URL}/api/elite-cars/${testCarId}`, {
      method: 'DELETE',
    });
    console.log(`Delete HTTP Status: ${deleteRes.status}`);

    // Verify deletion in DB
    const deletedDbCar = await prisma.eliteCar.findUnique({
      where: { id: testCarId },
    });
    console.log(`Car Exists in DB After Delete: ${deletedDbCar !== null}`);

    if (deletedDbCar !== null) {
      throw new Error('Car was not deleted from PostgreSQL!');
    }

    console.log('\n====================================================');
    console.log('🎉 ELITE CARS E2E AUDIT PASSED 100%!');
    console.log('====================================================');
  } catch (err: any) {
    console.error('❌ Error in Elite Cars test:', err);
    process.exit(1);
  } finally {
    if (testCarId) {
      try {
        await prisma.eliteCar.deleteMany({ where: { id: testCarId } });
      } catch (_) {}
    }
    await prisma.$disconnect();
  }
}

testEliteCarsE2E();
