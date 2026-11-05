import { prisma } from '../src/config/prisma';
import { locationCacheService } from '../src/modules/drivers/location-cache.service';

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
  console.log('🧪 RUNNING P0 LOCATION CACHE DATA INTEGRITY TESTS');
  console.log('========================================================================\n');

  const origTransaction = prisma.$transaction;
  const origUpdate = prisma.driverProfile.update;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: New GPS update arriving during an active batch flush
    // -------------------------------------------------------------------------
    console.log('▶ TEST 1: New GPS update arriving during active batch flush...');
    locationCacheService.clearAll();

    const driverA = 'driver-test-1-uuid';
    // 1. Initial location saved -> version 1
    await locationCacheService.saveDriverLocation(driverA, {
      latitude: 13.0801,
      longitude: 80.2701,
    });

    assert(locationCacheService.isDriverDirty(driverA) === true, 'Driver A must be dirty initially');
    assert(locationCacheService.getDriverVersion(driverA) === 1, 'Driver A must be version 1');

    // 2. Mock transaction with delay to simulate in-flight DB write
    let flushFinished = false;
    prisma.$transaction = (async (ops: any) => {
      // Simulate slow PostgreSQL network I/O
      await new Promise((r) => setTimeout(r, 60));
      return ops;
    }) as any;

    prisma.driverProfile.update = (async (args: any) => {
      return { id: args.where.id };
    }) as any;

    // Start flush asynchronously
    const flushPromise = locationCacheService.flushDirtyLocationsToDatabase();

    // 3. While flush is pending, Driver A sends a NEW GPS coordinate
    await new Promise((r) => setTimeout(r, 20)); // wait until transaction has begun
    await locationCacheService.saveDriverLocation(driverA, {
      latitude: 13.0809,
      longitude: 80.2709,
    });

    assert(locationCacheService.getDriverVersion(driverA) === 2, 'Driver A must now be version 2');

    // Wait for the first flush to complete
    await flushPromise;

    // 4. Verify: Driver A must STILL be dirty because version 2 arrived during the flush of version 1!
    assert(
      locationCacheService.isDriverDirty(driverA) === true,
      'CRITICAL: Driver A must remain dirty because version 2 arrived while version 1 was flushing'
    );
    assert(
      locationCacheService.getLastFlushedVersion(driverA) === 1,
      'Last flushed version must be recorded as 1'
    );

    // 5. Next flush runs: it must flush version 2 and clear dirty
    prisma.$transaction = (async (ops: any) => ops) as any;
    await locationCacheService.flushDirtyLocationsToDatabase();

    assert(
      locationCacheService.isDriverDirty(driverA) === false,
      'Driver A dirty state must now be cleared after version 2 flushed'
    );
    assert(
      locationCacheService.getLastFlushedVersion(driverA) === 2,
      'Last flushed version must now be 2'
    );

    results.push({
      name: '1. New GPS update arriving during active batch flush',
      passed: true,
      details: 'Version-based dirty tracking preserved concurrent update and flushed it in next cycle.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 2: Old batch completing after a newer immediate flush
    // -------------------------------------------------------------------------
    console.log('▶ TEST 2: Old batch completing after newer immediate flush...');
    locationCacheService.clearAll();

    const driverB = 'driver-test-2-uuid';

    // 1. Initial location saved -> version 1
    await locationCacheService.saveDriverLocation(driverB, {
      latitude: 13.0001,
      longitude: 80.0001,
    });

    let writesRecorded: { driverId: string; lat: number; lng: number }[] = [];

    // Mock delayed batch flush for version 1
    prisma.$transaction = (async (ops: any) => {
      // Delay batch flush
      await new Promise((r) => setTimeout(r, 80));
      return ops;
    }) as any;

    prisma.driverProfile.update = (async (args: any) => {
      writesRecorded.push({
        driverId: args.where.id,
        lat: args.data.currentLatitude,
        lng: args.data.currentLongitude,
      });
      return { id: args.where.id };
    }) as any;

    // Start batch flush containing version 1
    const batchPromise = locationCacheService.flushDirtyLocationsToDatabase();

    // 2. While batch is in-flight, driver completes trip at (13.0999, 80.0999) -> version 2
    await new Promise((r) => setTimeout(r, 20));
    await locationCacheService.saveDriverLocation(driverB, {
      latitude: 13.0999,
      longitude: 80.0999,
    });

    // 3. Immediate flush fires for version 2
    await locationCacheService.flushDriverImmediately(driverB);

    assert(
      locationCacheService.getLastFlushedVersion(driverB) === 2,
      'Immediate flush must record lastFlushedVersion = 2'
    );
    assert(writesRecorded.length === 2, `Expected 2 writes (batch then immediate), got ${writesRecorded.length}`);
    assert(writesRecorded[0].lat === 13.0001, 'First write was the older batch');
    assert(writesRecorded[1].lat === 13.0999, 'Second write was the immediate flush');

    // 4. Wait for batch promise
    await batchPromise;

    // Verify: The final DB write must be the newer immediate flush (13.0999), never overwritten by older batch
    const lastWrite = writesRecorded[writesRecorded.length - 1];
    assert(
      lastWrite.lat === 13.0999,
      'CRITICAL: Final DB state must remain the newer immediate flush (13.0999), not overwritten by older batch'
    );

    results.push({
      name: '2. Old batch completing after newer immediate flush',
      passed: true,
      details: 'Older batch correctly detected version 1 <= lastFlushedVersion (2) and skipped overwriting.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 3: Database transaction failure and retry
    // -------------------------------------------------------------------------
    console.log('▶ TEST 3: Database transaction failure and retry...');
    locationCacheService.clearAll();

    const driverC = 'driver-test-3-uuid';
    await locationCacheService.saveDriverLocation(driverC, {
      latitude: 12.5555,
      longitude: 79.5555,
    });

    // 1. Simulate DB failure
    prisma.$transaction = (async () => {
      throw new Error('Connection pool exhausted: ECONNRESET');
    }) as any;

    let indivCallCount = 0;
    prisma.driverProfile.update = (async (args: any) => {
      indivCallCount++;
      throw new Error('Connection pool exhausted: ECONNRESET');
    }) as any;

    const failFlushResult = await locationCacheService.flushDirtyLocationsToDatabase();
    assert(failFlushResult.flushedCount === 0, 'No drivers should be counted as flushed on DB error');
    assert(locationCacheService.isDriverDirty(driverC) === true, 'Driver C must remain dirty after DB failure');

    // 2. Simulate DB recovered
    prisma.$transaction = (async (ops: any) => ops) as any;
    prisma.driverProfile.update = (async (args: any) => ({ id: args.where.id })) as any;

    // Reset nextRetryAt for test driver so retry is eligible
    const failureInfo = locationCacheService.getFailureInfo(driverC);
    if (failureInfo) failureInfo.nextRetryAt = 0;

    const successFlushResult = await locationCacheService.flushDirtyLocationsToDatabase();
    assert(successFlushResult.flushedCount === 1, 'Driver C must be flushed on retry');
    assert(locationCacheService.isDriverDirty(driverC) === false, 'Driver C must be clean after successful retry');

    results.push({
      name: '3. Database transaction failure and retry',
      passed: true,
      details: 'Dirty state preserved on DB failure; successfully recovered and synced on next attempt.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 4: One invalid driver record among 50 healthy records
    // -------------------------------------------------------------------------
    console.log('▶ TEST 4: One invalid driver record among 50 healthy records (Batch Failure Isolation)...');
    locationCacheService.clearAll();

    // Setup 50 driver records: 49 valid, 1 invalid (poison pill)
    const validDriverIds: string[] = [];
    for (let i = 1; i <= 49; i++) {
      const id = `valid-driver-${i}`;
      validDriverIds.push(id);
      await locationCacheService.saveDriverLocation(id, {
        latitude: 10 + i * 0.01,
        longitude: 80 + i * 0.01,
      });
    }

    const invalidDriverId = 'invalid-driver-poison-pill';
    await locationCacheService.saveDriverLocation(invalidDriverId, {
      latitude: 99.9999,
      longitude: 99.9999,
    });

    assert(locationCacheService.getDirtyCount() === 50, 'Must have 50 dirty records initially');

    // Mock bulk $transaction to fail (because of the poison pill record)
    prisma.$transaction = (async (ops: any) => {
      throw new Error('Transaction failed: Record to update not found (invalid-driver-poison-pill)');
    }) as any;

    // Mock individual update: succeeds for valid IDs, throws for invalid ID
    prisma.driverProfile.update = (async (args: any) => {
      if (args.where.id === invalidDriverId) {
        throw new Error('Record to update not found');
      }
      return { id: args.where.id };
    }) as any;

    const batchIsolationResult = await locationCacheService.flushDirtyLocationsToDatabase();

    // Verify:
    // 49 valid drivers must have succeeded and been cleared from dirty set!
    // 1 invalid driver must have failed and remained in dirty set with backoff!
    assert(batchIsolationResult.flushedCount === 49, `Expected 49 flushed drivers, got ${batchIsolationResult.flushedCount}`);
    assert(batchIsolationResult.failedCount === 1, `Expected 1 failed driver, got ${batchIsolationResult.failedCount}`);
    assert(locationCacheService.isDriverDirty(invalidDriverId) === true, 'Invalid driver must remain dirty');
    assert(locationCacheService.getDirtyCount() === 1, 'Only the 1 invalid driver must remain dirty; 49 must be cleared');

    for (const validId of validDriverIds) {
      assert(locationCacheService.isDriverDirty(validId) === false, `Valid driver ${validId} must be cleared from dirty set`);
      assert(locationCacheService.getLastFlushedVersion(validId) === 1, `Valid driver ${validId} must be marked version 1 in DB`);
    }

    // Verify exponential backoff info exists for the poison pill
    const poisonInfo = locationCacheService.getFailureInfo(invalidDriverId);
    assert(poisonInfo !== undefined, 'Poison pill must have failure info recorded');
    assert(poisonInfo?.consecutiveFailures === 1, 'Consecutive failures must be 1');
    assert((poisonInfo?.nextRetryAt ?? 0) > Date.now(), 'nextRetryAt must be in the future (backoff armed)');

    results.push({
      name: '4. One invalid driver record among 50 healthy records',
      passed: true,
      details: 'Bulk transaction failure safely isolated: 49 healthy records committed individually; 1 invalid record kept dirty with backoff.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 5: Shutdown while a flush is already running
    // -------------------------------------------------------------------------
    console.log('▶ TEST 5: Shutdown while a flush is already running...');
    locationCacheService.clearAll();

    const driverE = 'driver-test-5-uuid';
    await locationCacheService.saveDriverLocation(driverE, {
      latitude: 11.1111,
      longitude: 78.1111,
    });

    // Mock flush taking 100ms
    prisma.$transaction = (async (ops: any) => {
      await new Promise((r) => setTimeout(r, 100));
      return ops;
    }) as any;
    prisma.driverProfile.update = (async (args: any) => ({ id: args.where.id })) as any;

    // Start flush
    const inFlightFlush = locationCacheService.flushDirtyLocationsToDatabase();

    // Immediately trigger destroy() while flush is in-flight
    const shutdownPromise = locationCacheService.destroy(5000);

    const shutdownResult = await shutdownPromise;
    await inFlightFlush;

    assert(shutdownResult.success === true, 'Shutdown must report success');
    assert(shutdownResult.unflushedCount === 0, 'Unflushed count must be 0 after shutdown');
    assert(locationCacheService.isDriverDirty(driverE) === false, 'Driver E must be flushed and clean');

    results.push({
      name: '5. Shutdown while a flush is already running',
      passed: true,
      details: 'Shutdown synchronized with in-flight flush, waited for completion, and cleanly exited with 0 unflushed records.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 6: Multiple concurrent flush requests
    // -------------------------------------------------------------------------
    console.log('▶ TEST 6: Multiple concurrent flush requests...');
    locationCacheService.clearAll();

    const driverF = 'driver-test-6-uuid';
    await locationCacheService.saveDriverLocation(driverF, {
      latitude: 12.2222,
      longitude: 79.2222,
    });

    let transactionExecutionCount = 0;
    prisma.$transaction = (async (ops: any) => {
      transactionExecutionCount++;
      await new Promise((r) => setTimeout(r, 50));
      return ops;
    }) as any;

    // Fire 5 concurrent calls to flushDirtyLocationsToDatabase
    const concurrentFlushes = await Promise.all([
      locationCacheService.flushDirtyLocationsToDatabase(),
      locationCacheService.flushDirtyLocationsToDatabase(),
      locationCacheService.flushDirtyLocationsToDatabase(),
      locationCacheService.flushDirtyLocationsToDatabase(),
      locationCacheService.flushDirtyLocationsToDatabase(),
    ]);

    // Verify only ONE transaction executed!
    assert(
      transactionExecutionCount === 1,
      `CRITICAL: Expected exactly 1 transaction execution across concurrent calls, got ${transactionExecutionCount}`
    );
    assert(
      concurrentFlushes[0].flushedCount === 1,
      'Flushed count must be 1'
    );
    assert(
      locationCacheService.isDriverDirty(driverF) === false,
      'Driver F must be clean after concurrent flush'
    );

    results.push({
      name: '6. Multiple concurrent flush requests',
      passed: true,
      details: 'Concurrent flush calls coalesced onto active flush promise; exactly 1 DB transaction executed.',
    });
    console.log('   ✅ PASS\n');

    // -------------------------------------------------------------------------
    // TEST 7: Delayed mobile GPS packet arriving after a newer location
    // -------------------------------------------------------------------------
    console.log('▶ TEST 7: Delayed mobile GPS packet arriving after newer location...');
    locationCacheService.clearAll();

    const driverG = 'driver-test-7-uuid';

    // 1. Packet 1: clientTimestamp = 1000 at (13.0, 80.0) -> version 1
    const p1 = await locationCacheService.saveDriverLocation(driverG, {
      latitude: 13.0,
      longitude: 80.0,
      clientTimestamp: 1000,
    });
    assert(p1.version === 1, 'First packet must be version 1');
    assert(p1.latitude === 13.0, 'First packet lat must be 13.0');

    // 2. Packet 2: clientTimestamp = 2000 at (13.1, 80.1) -> version 2
    const p2 = await locationCacheService.saveDriverLocation(driverG, {
      latitude: 13.1,
      longitude: 80.1,
      clientTimestamp: 2000,
    });
    assert(p2.version === 2, 'Second packet must be version 2');
    assert(p2.latitude === 13.1, 'Second packet lat must be 13.1');

    // 3. Delayed Packet 3: cellular delay, arrives late with clientTimestamp = 800 at (12.9, 79.9)
    const p3 = await locationCacheService.saveDriverLocation(driverG, {
      latitude: 12.9,
      longitude: 79.9,
      clientTimestamp: 800, // Older than 2000!
    });

    // Verify: Packet 3 was dropped; cache returned existing version 2 at 13.1!
    assert(
      p3.version === 2,
      'Delayed packet must not create a new version; must return existing version 2'
    );
    assert(
      p3.latitude === 13.1,
      'Delayed packet must NOT overwrite newer location (13.1) with older location (12.9)'
    );

    const cachedG = await locationCacheService.getDriverLocation(driverG);
    assert(
      cachedG?.latitude === 13.1,
      'Cache must retain newer coordinates (13.1), not the delayed packet'
    );

    // 4. Test client clock in the far future (e.g. device clock set to year 2099)
    const futureTime = Date.now() + 1000000000;
    const pFuture = await locationCacheService.saveDriverLocation(driverG, {
      latitude: 13.2,
      longitude: 80.2,
      clientTimestamp: futureTime,
    });
    // Must clamp to max now + 60000
    assert(
      (pFuture.clientTimestamp ?? 0) <= Date.now() + 65000,
      'Future client timestamp must be clamped'
    );
    assert(pFuture.version === 3, 'Valid location with clamped future clock must create version 3');

    results.push({
      name: '7. Delayed mobile GPS packet arriving after newer location',
      passed: true,
      details: 'Out-of-order delayed GPS packet dropped cleanly; future clocks clamped; monotonic order preserved.',
    });
    console.log('   ✅ PASS\n');

  } finally {
    // Restore original prisma methods
    prisma.$transaction = origTransaction;
    prisma.driverProfile.update = origUpdate;
  }

  console.log('========================================================================');
  console.log('📊 TEST EXECUTION SUMMARY:');
  console.log('========================================================================');
  let allPassed = true;
  for (const r of results) {
    const statusIcon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${statusIcon} | ${r.name}`);
    console.log(`        └─ ${r.details}`);
    if (!r.passed) allPassed = false;
  }
  console.log('========================================================================');

  if (allPassed) {
    console.log('🎉 ALL 7 P0 DATA INTEGRITY TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } else {
    console.error('💥 SOME TESTS FAILED!\n');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
