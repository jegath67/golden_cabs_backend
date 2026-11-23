import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/config/prisma';
import { favoritesService } from '../src/modules/favorites/favorites.service';

async function runFavoritesTests() {
  const stamp = Date.now().toString();
  console.log(`[TEST] Starting Customer Favorites Backend Suite (stamp: ${stamp})`);

  let customerAId = '';
  let customerBId = '';
  let carId = '';
  let placeId = '';

  try {
    // Setup test customers
    const custA = await prisma.user.create({
      data: {
        phone: `9333${stamp.slice(-6)}`,
        name: `Customer A ${stamp}`,
        role: 'CUSTOMER',
      },
    });
    customerAId = custA.id;

    const custB = await prisma.user.create({
      data: {
        phone: `9444${stamp.slice(-6)}`,
        name: `Customer B ${stamp}`,
        role: 'CUSTOMER',
      },
    });
    customerBId = custB.id;

    // Setup test catalog items
    const car = await prisma.eliteCar.create({
      data: {
        brand: 'Mercedes',
        model: `C-Class ${stamp.slice(-4)}`,
        category: 'Luxury',
        image: 'https://example.com/car.jpg',
        price: '₹5,000/day',
      },
    });
    carId = car.id;

    const place = await prisma.explorePlace.create({
      data: {
        name: `Test Cafe ${stamp.slice(-4)}`,
        category: 'Cafes',
        location: 'Anna Nagar, Chennai',
        imageUrl: 'https://example.com/cafe.jpg',
      },
    });
    placeId = place.id;

    // Test 1: Add favorite car and place for Customer A
    console.log('[TEST 1] Add favorite car and place for Customer A');
    const favCarA = await favoritesService.addFavorite(customerAId, 'CAR', carId);
    assert.equal(favCarA.customerId, customerAId);
    assert.equal(favCarA.itemType, 'CAR');
    assert.equal(favCarA.itemId, carId);

    const favPlaceA = await favoritesService.addFavorite(customerAId, 'EXPLORE', placeId);
    assert.equal(favPlaceA.customerId, customerAId);
    assert.equal(favPlaceA.itemType, 'EXPLORE');
    assert.equal(favPlaceA.itemId, placeId);
    console.log('✓ Test 1 passed');

    // Test 2: Idempotency (Duplicate add does not create duplicate rows)
    console.log('[TEST 2] Duplicate add is handled idempotently without error');
    const duplicateFav = await favoritesService.addFavorite(customerAId, 'CAR', carId);
    assert.equal(duplicateFav.id, favCarA.id, 'Duplicate add should return existing favorite id');

    const favsListA = await favoritesService.getFavorites(customerAId);
    assert.equal(favsListA.cars.length, 1);
    assert.equal(favsListA.explore.length, 1);
    assert.equal(favsListA.favoriteRecords.length, 2);
    console.log('✓ Test 2 passed');

    // Test 3: Data Isolation (Customer B cannot see Customer A favorites)
    console.log('[TEST 3] Customer B has 0 favorites and cannot see Customer A favorites');
    const favsListB = await favoritesService.getFavorites(customerBId);
    assert.equal(favsListB.cars.length, 0);
    assert.equal(favsListB.explore.length, 0);
    assert.equal(favsListB.favoriteRecords.length, 0);
    console.log('✓ Test 3 passed');

    // Test 4: Isolation on Delete (Customer B cannot delete Customer A favorites)
    console.log('[TEST 4] Customer B cannot delete Customer A favorites');
    const deleteAttempt = await favoritesService.removeFavorite(customerBId, 'CAR', carId);
    assert.equal(deleteAttempt.count, 0, 'Delete by non-owner should affect 0 rows');

    // Verify Customer A still has their favorite
    const favsAAfter = await favoritesService.getFavorites(customerAId);
    assert.equal(favsAAfter.cars.length, 1, 'Customer A favorite must remain intact');
    console.log('✓ Test 4 passed');

    // Test 5: Validation - Invalid itemType or empty itemId is rejected
    console.log('[TEST 5] Invalid itemType or empty itemId is rejected');
    await assert.rejects(
      async () => {
        await favoritesService.addFavorite(customerAId, 'INVALID' as any, carId);
      },
      /Invalid itemType/
    );
    await assert.rejects(
      async () => {
        await favoritesService.addFavorite(customerAId, 'CAR', '');
      },
      /itemId is required/
    );
    console.log('✓ Test 5 passed');

    // Test 6: Remove favorite by Customer A
    console.log('[TEST 6] Customer A successfully removes favorite');
    const removeRes = await favoritesService.removeFavorite(customerAId, 'CAR', carId);
    assert.equal(removeRes.count, 1);

    const favsAFinal = await favoritesService.getFavorites(customerAId);
    assert.equal(favsAFinal.cars.length, 0);
    assert.equal(favsAFinal.explore.length, 1);
    console.log('✓ Test 6 passed');

    // Test 7: Catalog Validation - Non-existent car or place is rejected with 404
    console.log('[TEST 7] Catalog Validation: Non-existent car or place is rejected with 404');
    await assert.rejects(
      async () => {
        await favoritesService.addFavorite(customerAId, 'CAR', '00000000-0000-0000-0000-000000000000');
      },
      (err: any) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /not found in catalog/);
        return true;
      }
    );
    await assert.rejects(
      async () => {
        await favoritesService.addFavorite(customerAId, 'EXPLORE', '00000000-0000-0000-0000-000000000000');
      },
      (err: any) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /not found in catalog/);
        return true;
      }
    );
    console.log('✓ Test 7 passed');

    console.log('\n[ALL BACKEND FAVORITES TESTS PASSED SUCCESSFULLY!]');
  } finally {
    // Cleanup test data
    if (customerAId) {
      await prisma.customerFavorite.deleteMany({ where: { customerId: customerAId } });
      await prisma.user.deleteMany({ where: { id: customerAId } });
    }
    if (customerBId) {
      await prisma.customerFavorite.deleteMany({ where: { customerId: customerBId } });
      await prisma.user.deleteMany({ where: { id: customerBId } });
    }
    if (carId) {
      await prisma.eliteCar.deleteMany({ where: { id: carId } });
    }
    if (placeId) {
      await prisma.explorePlace.deleteMany({ where: { id: placeId } });
    }
    await prisma.$disconnect();
  }
}

runFavoritesTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
