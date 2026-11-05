import { prisma } from '../src/config/prisma';
import { calculateRedisBackoffDelay, setRedisClientForTest } from '../src/config/redis';
import { LocationCacheService, locationCacheService } from '../src/modules/drivers/location-cache.service';
import { adminController } from '../src/modules/admin/admin.controller';

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log('========================================================================');
  console.log('🧪 RUNNING P1 REDIS RELIABILITY & ADMIN LIVE MAP TESTS');
  console.log('========================================================================\n');

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Redis Exponential Backoff with Jitter
    // -------------------------------------------------------------------------
    console.log('▶ TEST 1: Redis reconnection exponential backoff & delay bounding...');
    {
      const delay1 = calculateRedisBackoffDelay(1);
      assert(delay1 >= 1000 && delay1 <= 1500, `Attempt 1 delay should be ~1000ms + jitter, got ${delay1}`);

      const delay2 = calculateRedisBackoffDelay(2);
      assert(delay2 >= 1500 && delay2 <= 2000, `Attempt 2 delay should be ~1500ms + jitter, got ${delay2}`);

      const delay3 = calculateRedisBackoffDelay(3);
      assert(delay3 >= 2250 && delay3 <= 2750, `Attempt 3 delay should be ~2250ms + jitter, got ${delay3}`);

      // Attempt 15 (large attempt count) must be capped at 15000ms + 500ms jitter
      const delay15 = calculateRedisBackoffDelay(15);
      assert(delay15 >= 15000 && delay15 <= 15500, `Large attempt delay must be capped at 15000ms + jitter, got ${delay15}`);

      // Never returns null or zero
      for (let i = 1; i <= 20; i++) {
        const d = calculateRedisBackoffDelay(i);
        assert(typeof d === 'number' && d > 0, `Delay must be positive number at attempt ${i}`);
      }

      results.push({
        name: '1. Redis reconnection exponential backoff',
        passed: true,
        details: 'Exponential backoff smoothly increases and caps at 15000ms + jitter; never permanently gives up.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 2: In-Memory Fallback when Redis is Unavailable
    // -------------------------------------------------------------------------
    console.log('▶ TEST 2: In-memory fallback when Redis is offline/unavailable...');
    {
      // Simulate Redis being completely unavailable
      setRedisClientForTest(null);

      locationCacheService.clearAll();
      const driverId = 'fallback-driver-001';

      await locationCacheService.saveDriverLocation(driverId, {
        latitude: 13.0827,
        longitude: 80.2707,
      });

      const locs = await locationCacheService.getLocationsForDrivers([driverId]);
      assert(locs.has(driverId), 'Location must be retrieved from in-memory fallback');
      const retrieved = locs.get(driverId)!;
      assert(retrieved.latitude === 13.0827, 'Latitude must match');
      assert(retrieved.longitude === 80.2707, 'Longitude must match');
      assert(retrieved.version === 1, 'Version must be 1');

      results.push({
        name: '2. In-memory fallback when Redis is offline',
        passed: true,
        details: 'Zero errors when Redis is unavailable; transparent fallback to in-memory store.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 3: Multi-Instance Cross-Container Location Consistency
    // -------------------------------------------------------------------------
    console.log('▶ TEST 3: Multi-instance Redis pipeline synchronization...');
    {
      // Mock Redis client simulating a shared cluster
      const sharedRedisStore = new Map<string, Record<string, string>>();

      const mockRedisInstance = {
        status: 'ready',
        hset: async (key: string, data: Record<string, any>) => {
          const stringified: Record<string, string> = {};
          for (const [k, v] of Object.entries(data)) {
            stringified[k] = String(v);
          }
          sharedRedisStore.set(key, stringified);
          return 1;
        },
        pipeline: () => {
          const commands: (() => [null, any])[] = [];
          return {
            hset: (key: string, data: Record<string, any>) => {
              commands.push(() => {
                const stringified: Record<string, string> = {};
                for (const [k, v] of Object.entries(data)) {
                  stringified[k] = String(v);
                }
                sharedRedisStore.set(key, stringified);
                return [null, 1];
              });
            },
            expire: () => {
              commands.push(() => [null, 1]);
            },
            geoadd: () => {
              commands.push(() => [null, 1]);
            },
            sadd: () => {
              commands.push(() => [null, 1]);
            },
            hgetall: (key: string) => {
              commands.push(() => [null, sharedRedisStore.get(key) || {}]);
            },
            exec: async () => {
              return commands.map((cmd) => cmd());
            },
          };
        },
      };

      setRedisClientForTest(mockRedisInstance as any, true);

      // Instance A: Separate service instance
      const instanceA = new LocationCacheService();
      // Instance B: Separate service instance
      const instanceB = new LocationCacheService();

      const driverX = 'drv-shared-x';
      const driverY = 'drv-shared-y';

      // Instance A receives GPS ping for driverX
      await instanceA.saveDriverLocation(driverX, {
        latitude: 13.0850,
        longitude: 80.2750,
        heading: 90,
      });

      // Instance B has NEVER seen driverX in its local memory
      assert(instanceB.getDriverVersion(driverX) === 0, 'Instance B memoryCache must be empty for driverX');

      // Instance B queries for both driverX and driverY
      const locsFromInstanceB = await instanceB.getLocationsForDrivers([driverX, driverY]);

      assert(locsFromInstanceB.has(driverX), 'Instance B must retrieve driverX from shared Redis pipeline');
      const retrievedX = locsFromInstanceB.get(driverX)!;
      assert(retrievedX.latitude === 13.0850, 'Latitude must match shared Redis coordinate');
      assert(retrievedX.longitude === 80.2750, 'Longitude must match shared Redis coordinate');
      assert(retrievedX.version === 1, 'Version must be 1');

      // Instance B receives GPS ping for driverY
      await instanceB.saveDriverLocation(driverY, {
        latitude: 11.9416,
        longitude: 79.8083,
        heading: 180,
      });

      // Instance A queries for driverY
      const locsFromInstanceA = await instanceA.getLocationsForDrivers([driverY]);
      assert(locsFromInstanceA.has(driverY), 'Instance A must retrieve driverY saved by Instance B');
      assert(locsFromInstanceA.get(driverY)!.latitude === 11.9416, 'Instance A sees Instance B coordinates');

      results.push({
        name: '3. Multi-instance cross-container synchronization',
        passed: true,
        details: 'Instance B successfully reads coordinates written by Instance A via pipelined Redis HGETALL.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 4: Offline Driver -> Stale Cache Filtered Out
    // -------------------------------------------------------------------------
    console.log('▶ TEST 4: Offline driver stale cache filtering...');
    {
      const now = Date.now();
      const offlineDriverId = 'drv-offline-test';

      // Cached coordinate is present in Redis / memory
      locationCacheService.clearAll();
      await locationCacheService.saveDriverLocation(offlineDriverId, {
        latitude: 13.9999, // Moving cache
        longitude: 80.9999,
      });

      // Mock Prisma response for Live Map
      const origFindManyRides = prisma.ride.findMany;
      const origFindManyDrivers = prisma.driverProfile.findMany;

      prisma.ride.findMany = (async () => []) as any; // No active rides
      prisma.driverProfile.findMany = (async () => [
        {
          id: offlineDriverId,
          isOnline: false,
          shiftStatus: 'OFF_SHIFT',
          currentLatitude: 13.0800, // DB resting coordinate
          currentLongitude: 80.2700,
          updatedAt: new Date(now - 3600 * 1000),
          user: { id: 'usr-1', name: 'Offline Driver', phone: '9876543210', isActive: true },
          assignedVehicle: { model: 'Dzire', vehicleNumber: 'TN-01-AB-1234', vehicleType: 'Sedan' },
          assignedHub: { city: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
          rides: [],
        },
      ]) as any;

      let responseData: any = null;
      const mockReq = { log: console } as any;
      const mockReply = {
        send: (payload: any) => {
          responseData = payload;
          return mockReply;
        },
        status: () => mockReply,
      } as any;

      await adminController.getLiveMapData(mockReq, mockReply);

      assert(responseData && responseData.success === true, 'Admin API must succeed');
      const driverOutput = responseData.data.drivers[0];
      assert(driverOutput.status === 'Offline', 'Driver status must be Offline');
      assert(
        driverOutput.latitude === 13.0800 && driverOutput.longitude === 80.2700,
        `Offline driver must show DB resting position (13.0800, 80.2700), got (${driverOutput.latitude}, ${driverOutput.longitude})`
      );

      prisma.ride.findMany = origFindManyRides;
      prisma.driverProfile.findMany = origFindManyDrivers;

      results.push({
        name: '4. Offline driver stale cache filtering',
        passed: true,
        details: 'Offline driver moving cache was filtered out; authoritative DB resting position was displayed.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 5: Online Driver with Stale Ping (> 5 min) Falls Back to DB
    // -------------------------------------------------------------------------
    console.log('▶ TEST 5: Online driver with stale ping (> 5 mins) fallback to DB...');
    {
      const now = Date.now();
      const staleDriverId = 'drv-stale-test';

      locationCacheService.clearAll();
      // Inject coordinate older than 5 minutes (e.g. 7 minutes ago)
      (locationCacheService as any).memoryCache.set(staleDriverId, {
        driverId: staleDriverId,
        latitude: 13.5555,
        longitude: 80.5555,
        updatedAt: now - 7 * 60 * 1000,
        version: 1,
      });

      const origFindManyRides = prisma.ride.findMany;
      const origFindManyDrivers = prisma.driverProfile.findMany;

      prisma.ride.findMany = (async () => []) as any;
      prisma.driverProfile.findMany = (async () => [
        {
          id: staleDriverId,
          isOnline: true,
          shiftStatus: 'ON_SHIFT',
          currentLatitude: 13.0100, // DB resting coordinate
          currentLongitude: 80.2100,
          updatedAt: new Date(now - 7 * 60 * 1000),
          user: { id: 'usr-2', name: 'Stale Online Driver', phone: '9876543211', isActive: true },
          assignedVehicle: { model: 'Etios', vehicleNumber: 'TN-01-CD-5678', vehicleType: 'Sedan' },
          assignedHub: { city: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
          rides: [],
        },
      ]) as any;

      let responseData: any = null;
      const mockReq = { log: console } as any;
      const mockReply = {
        send: (payload: any) => {
          responseData = payload;
          return mockReply;
        },
        status: () => mockReply,
      } as any;

      await adminController.getLiveMapData(mockReq, mockReply);

      const driverOutput = responseData.data.drivers[0];
      assert(driverOutput.status === 'Online', 'Driver status must be Online');
      assert(
        driverOutput.latitude === 13.0100 && driverOutput.longitude === 80.2100,
        `Stale online driver coordinate must fall back to DB (13.0100, 80.2100), got (${driverOutput.latitude}, ${driverOutput.longitude})`
      );

      prisma.ride.findMany = origFindManyRides;
      prisma.driverProfile.findMany = origFindManyDrivers;

      results.push({
        name: '5. Online driver stale location fallback (>5 mins)',
        passed: true,
        details: 'Online driver with GPS ping older than 5 minutes reverted safely to DB coordinates.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 6: Online Driver with Fresh Ping (< 5 min) Shows Cached Coordinate
    // -------------------------------------------------------------------------
    console.log('▶ TEST 6: Online driver with fresh ping (< 5 mins) shows cached coordinate...');
    {
      const now = Date.now();
      const freshDriverId = 'drv-fresh-test';

      locationCacheService.clearAll();
      // Inject coordinate 30 seconds ago
      (locationCacheService as any).memoryCache.set(freshDriverId, {
        driverId: freshDriverId,
        latitude: 13.0666,
        longitude: 80.2666,
        updatedAt: now - 30 * 1000,
        version: 1,
      });

      const origFindManyRides = prisma.ride.findMany;
      const origFindManyDrivers = prisma.driverProfile.findMany;

      prisma.ride.findMany = (async () => []) as any;
      prisma.driverProfile.findMany = (async () => [
        {
          id: freshDriverId,
          isOnline: true,
          shiftStatus: 'ON_SHIFT',
          currentLatitude: 13.0000, // Older DB coordinate
          currentLongitude: 80.2000,
          updatedAt: new Date(now - 600 * 1000),
          user: { id: 'usr-3', name: 'Fresh Online Driver', phone: '9876543212', isActive: true },
          assignedVehicle: { model: 'Innova', vehicleNumber: 'TN-01-EF-9012', vehicleType: 'SUV' },
          assignedHub: { city: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
          rides: [],
        },
      ]) as any;

      let responseData: any = null;
      const mockReq = { log: console } as any;
      const mockReply = {
        send: (payload: any) => {
          responseData = payload;
          return mockReply;
        },
        status: () => mockReply,
      } as any;

      await adminController.getLiveMapData(mockReq, mockReply);

      const driverOutput = responseData.data.drivers[0];
      assert(driverOutput.status === 'Online', 'Driver status must be Online');
      assert(
        driverOutput.latitude === 13.0666 && driverOutput.longitude === 80.2666,
        `Fresh online driver must show cached coordinate (13.0666, 80.2666), got (${driverOutput.latitude}, ${driverOutput.longitude})`
      );

      prisma.ride.findMany = origFindManyRides;
      prisma.driverProfile.findMany = origFindManyDrivers;

      results.push({
        name: '6. Online driver fresh location display (<5 mins)',
        passed: true,
        details: 'Online driver with recent GPS ping shows real-time cached position accurately.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 7: Active Ride Driver Preserves Real-Time Tracking
    // -------------------------------------------------------------------------
    console.log('▶ TEST 7: Active ride driver preserves real-time tracking (Rule 1)...');
    {
      const now = Date.now();
      const tripDriverId = 'drv-trip-test';
      const activeRideId = 'ride-trip-001';

      locationCacheService.clearAll();
      // Even if coordinate is from 6 minutes ago, active ride tracking must NOT be dropped!
      (locationCacheService as any).memoryCache.set(tripDriverId, {
        driverId: tripDriverId,
        latitude: 13.0999,
        longitude: 80.2999,
        updatedAt: now - 6 * 60 * 1000,
        version: 3,
      });

      const origFindManyRides = prisma.ride.findMany;
      const origFindManyDrivers = prisma.driverProfile.findMany;

      const rideObj = {
        id: activeRideId,
        bookingCode: 'GC-99999',
        status: 'ONGOING',
        pickupLocation: 'Chennai Central',
        dropLocation: 'Chennai Airport',
        pickupLat: 13.0827,
        pickupLng: 80.2707,
        dropLat: 12.9863,
        dropLng: 80.1706,
        estimatedFare: 500,
        finalFare: 500,
        distanceKm: 20,
        tripType: 'CITY_RIDE',
        driverId: tripDriverId,
        createdAt: new Date(now - 15 * 60 * 1000),
        customer: { id: 'cust-1', name: 'John Doe', phone: '9123456780' },
        driver: {
          id: tripDriverId,
          currentLatitude: 13.0800,
          currentLongitude: 80.2700,
          user: { id: 'usr-4', name: 'Trip Driver', phone: '9876543213' },
          assignedVehicle: { model: 'Dzire', vehicleNumber: 'TN-01-GH-3456', vehicleType: 'Sedan' },
        },
        stops: {},
      };

      prisma.ride.findMany = (async () => [rideObj]) as any;
      prisma.driverProfile.findMany = (async () => [
        {
          id: tripDriverId,
          isOnline: true,
          shiftStatus: 'ON_SHIFT',
          currentLatitude: 13.0800,
          currentLongitude: 80.2700,
          updatedAt: new Date(now - 10 * 60 * 1000),
          user: { id: 'usr-4', name: 'Trip Driver', phone: '9876543213', isActive: true },
          assignedVehicle: { model: 'Dzire', vehicleNumber: 'TN-01-GH-3456', vehicleType: 'Sedan' },
          assignedHub: { city: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
          rides: [rideObj],
        },
      ]) as any;

      let responseData: any = null;
      const mockReq = { log: console } as any;
      const mockReply = {
        send: (payload: any) => {
          responseData = payload;
          return mockReply;
        },
        status: () => mockReply,
      } as any;

      await adminController.getLiveMapData(mockReq, mockReply);

      const driverOutput = responseData.data.drivers[0];
      const rideOutput = responseData.data.rides[0];

      assert(driverOutput.status === 'On Trip', 'Driver status must be On Trip');
      assert(driverOutput.isOnTrip === true, 'isOnTrip must be true');
      assert(
        driverOutput.latitude === 13.0999 && driverOutput.longitude === 80.2999,
        `Active ride driver must retain cached tracking position (13.0999, 80.2999), got (${driverOutput.latitude}, ${driverOutput.longitude})`
      );

      // Verify ride object also received the cached driver position
      assert(
        rideOutput.driverLat === 13.0999 && rideOutput.driverLng === 80.2999,
        `Active ride must reflect latest cached driver position, got (${rideOutput.driverLat}, ${rideOutput.driverLng})`
      );

      prisma.ride.findMany = origFindManyRides;
      prisma.driverProfile.findMany = origFindManyDrivers;

      results.push({
        name: '7. Active ride location preservation',
        passed: true,
        details: 'Active ride tracking is never discarded; driver and active ride both display cached coordinates.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 8: API Response Contract Verification
    // -------------------------------------------------------------------------
    console.log('▶ TEST 8: Admin Live Map response contract verification...');
    {
      const origFindManyRides = prisma.ride.findMany;
      const origFindManyDrivers = prisma.driverProfile.findMany;

      prisma.ride.findMany = (async () => []) as any;
      prisma.driverProfile.findMany = (async () => []) as any;

      let responseData: any = null;
      const mockReq = { log: console } as any;
      const mockReply = {
        send: (payload: any) => {
          responseData = payload;
          return mockReply;
        },
        status: () => mockReply,
      } as any;

      await adminController.getLiveMapData(mockReq, mockReply);

      assert(responseData.success === true, 'Response must have success: true');
      assert(Array.isArray(responseData.data.drivers), 'data.drivers must be array');
      assert(Array.isArray(responseData.data.rides), 'data.rides must be array');
      assert(typeof responseData.data.stats === 'object', 'data.stats must be object');
      assert(typeof responseData.data.stats.totalDrivers === 'number', 'stats.totalDrivers must be number');
      assert(typeof responseData.data.stats.onlineDrivers === 'number', 'stats.onlineDrivers must be number');
      assert(typeof responseData.data.stats.availableDrivers === 'number', 'stats.availableDrivers must be number');
      assert(typeof responseData.data.stats.onTripDrivers === 'number', 'stats.onTripDrivers must be number');
      assert(typeof responseData.data.stats.offlineDrivers === 'number', 'stats.offlineDrivers must be number');
      assert(typeof responseData.data.stats.activeTrips === 'number', 'stats.activeTrips must be number');
      assert(typeof responseData.data.cityCenters === 'object', 'data.cityCenters must be object');

      prisma.ride.findMany = origFindManyRides;
      prisma.driverProfile.findMany = origFindManyDrivers;

      results.push({
        name: '8. Admin Live Map response contract integrity',
        passed: true,
        details: 'Response schema matches exact admin dashboard contract with zero breaking changes.',
      });
      console.log('   ✅ PASS\n');
    }

    // -------------------------------------------------------------------------
    // TEST 9: Inactive Memory Cache Pruning
    // -------------------------------------------------------------------------
    console.log('▶ TEST 9: Inactive non-dirty memory cache pruning (bounded memory)...');
    {
      locationCacheService.clearAll();
      const now = Date.now();

      // 1. Old flushed record (20 mins ago) -> should be evicted
      (locationCacheService as any).memoryCache.set('old-synced-drv', {
        driverId: 'old-synced-drv',
        latitude: 13.0,
        longitude: 80.0,
        updatedAt: now - 20 * 60 * 1000,
        version: 1,
      });

      // 2. Old DIRTY record (20 mins ago) -> must NOT be evicted!
      (locationCacheService as any).memoryCache.set('old-dirty-drv', {
        driverId: 'old-dirty-drv',
        latitude: 13.0,
        longitude: 80.0,
        updatedAt: now - 20 * 60 * 1000,
        version: 1,
      });
      (locationCacheService as any).dirtyDriverIds.add('old-dirty-drv');

      // 3. Recent record (2 mins ago) -> must NOT be evicted
      (locationCacheService as any).memoryCache.set('recent-drv', {
        driverId: 'recent-drv',
        latitude: 13.0,
        longitude: 80.0,
        updatedAt: now - 2 * 60 * 1000,
        version: 1,
      });

      const evicted = locationCacheService.cleanStaleMemoryCache(15 * 60 * 1000);
      assert(evicted === 1, `Expected 1 eviction, got ${evicted}`);
      assert(!(locationCacheService as any).memoryCache.has('old-synced-drv'), 'Old synced record must be evicted');
      assert((locationCacheService as any).memoryCache.has('old-dirty-drv'), 'Dirty record must be retained');
      assert((locationCacheService as any).memoryCache.has('recent-drv'), 'Recent record must be retained');

      results.push({
        name: '9. Inactive memory cache pruning',
        passed: true,
        details: 'Only non-dirty records older than 15 mins evicted; dirty and recent records safely protected.',
      });
      console.log('   ✅ PASS\n');
    }

  } catch (err: any) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('========================================================================');
  console.log('📊 TEST EXECUTION SUMMARY:');
  console.log('========================================================================');
  for (const r of results) {
    console.log(`✅ PASS | ${r.name}`);
    console.log(`        └─ ${r.details}`);
  }
  console.log('========================================================================');
  console.log(`🎉 ALL ${results.length} P1 REDIS & ADMIN LIVE MAP TESTS PASSED SUCCESSFULLY!\n`);
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
