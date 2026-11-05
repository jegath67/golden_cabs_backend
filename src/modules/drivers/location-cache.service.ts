import { prisma } from '../../config/prisma';
import { getRedisClient, isRedisAvailable } from '../../config/redis';

export interface DriverLocationData {
  driverId: string;
  userId?: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
  rideId?: string;
  clientTimestamp?: number;
  updatedAt: number;
  version: number;
}

export interface DriverFailureInfo {
  consecutiveFailures: number;
  nextRetryAt: number;
  lastError: string;
}

export class LocationCacheService {
  private memoryCache = new Map<string, DriverLocationData>();
  private dirtyDriverIds = new Set<string>();
  private lastFlushedVersion = new Map<string, number>();
  private failureTracking = new Map<string, DriverFailureInfo>();

  // P2 Optimization: In-Memory caches to reduce repetitive PostgreSQL queries during GPS pings
  private userToDriverIdCache = new Map<string, { driverId: string; cachedAt: number }>();
  private activeRideValidationCache = new Map<string, { driverId: string; status: string; cachedAt: number }>();
  private USER_DRIVER_MAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private RIDE_VALIDATION_TTL_MS = 60 * 1000; // 60 seconds

  private flushTimer: NodeJS.Timeout | null = null;
  private currentFlushPromise: Promise<{ flushedCount: number; failedCount: number }> | null = null;
  private flushIntervalMs = 5000; // Flush to PostgreSQL every 5 seconds
  private isDestroyed = false;

  /**
   * Initializes the background batch flush timer.
   */
  init(intervalMs = 5000) {
    this.flushIntervalMs = intervalMs;
    this.isDestroyed = false;
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flushDirtyLocationsToDatabase().catch((err) => {
        console.error('[LocationCache] Error during scheduled batch flush:', err);
      });
    }, this.flushIntervalMs);

    console.log(
      `[LocationCache] Background location batch sync armed (sync interval: ${this.flushIntervalMs / 1000}s).`
    );
  }

  /**
   * Saves or updates a driver's live GPS coordinates in Redis / In-Memory cache.
   * Monotonically tracks version numbers and prevents delayed mobile packets from overwriting newer server locations.
   */
  async saveDriverLocation(
    driverId: string,
    data: {
      userId?: string;
      latitude: number;
      longitude: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
      rideId?: string;
      clientTimestamp?: number;
      timestamp?: number;
    }
  ): Promise<DriverLocationData> {
    const existing = this.memoryCache.get(driverId);
    const now = Date.now();

    // 1. Out-of-order delayed mobile packet validation
    const rawClientTs = data.clientTimestamp ?? data.timestamp;
    let sanitizedClientTs: number | undefined;

    if (rawClientTs !== undefined && typeof rawClientTs === 'number' && Number.isFinite(rawClientTs)) {
      // Reject or clamp unrealistic future timestamps (> 60s ahead)
      sanitizedClientTs = Math.min(rawClientTs, now + 60000);

      // If this driver already has a newer client timestamp recorded, drop the delayed packet
      if (existing && existing.clientTimestamp !== undefined && sanitizedClientTs < existing.clientTimestamp) {
        console.warn(
          `[LocationCache] Dropped delayed GPS packet for driver ${driverId} (incoming clientTs: ${sanitizedClientTs} < cached clientTs: ${existing.clientTimestamp})`
        );
        return existing;
      }
    }

    // Monotonically increasing server timestamp and version
    const serverUpdatedAt = existing ? Math.max(now, existing.updatedAt + 1) : now;
    const nextVersion = (existing?.version ?? 0) + 1;

    const locationEntry: DriverLocationData = {
      driverId,
      userId: data.userId ?? existing?.userId,
      latitude: data.latitude,
      longitude: data.longitude,
      heading: data.heading,
      speed: data.speed,
      accuracy: data.accuracy,
      rideId: data.rideId,
      clientTimestamp: sanitizedClientTs,
      updatedAt: serverUpdatedAt,
      version: nextVersion,
    };

    // 1. Update In-Memory cache
    this.memoryCache.set(driverId, locationEntry);
    this.dirtyDriverIds.add(driverId);

    // 2. If Redis is available, write to Redis Hash, Redis GEO, and Redis Dirty Set
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const hashKey = `driver:location:${driverId}`;
          const geoKey = 'drivers:geo';
          const dirtySetKey = 'drivers:dirty';

          const pipeline = redis.pipeline();
          pipeline.hset(hashKey, {
            driverId,
            userId: data.userId || '',
            latitude: String(data.latitude),
            longitude: String(data.longitude),
            heading: String(data.heading ?? 0),
            speed: String(data.speed ?? 0),
            accuracy: String(data.accuracy ?? 0),
            rideId: data.rideId || '',
            clientTimestamp: String(locationEntry.clientTimestamp || ''),
            version: String(locationEntry.version),
            updatedAt: String(locationEntry.updatedAt),
          });
          pipeline.expire(hashKey, 3600); // 1 hour TTL
          pipeline.geoadd(geoKey, data.longitude, data.latitude, driverId);
          pipeline.sadd(dirtySetKey, driverId);
          await pipeline.exec();
        }
      } catch (err) {
        // Non-blocking fallback to in-memory
      }
    }

    return locationEntry;
  }

  /**
   * Retrieves the latest real-time coordinates for a driver from cache.
   * If not in cache, falls back to PostgreSQL.
   */
  async getDriverLocation(driverId: string): Promise<{ latitude: number; longitude: number } | null> {
    // 1. Check in-memory cache first
    const inMem = this.memoryCache.get(driverId);
    if (inMem && inMem.latitude != null && inMem.longitude != null) {
      return { latitude: inMem.latitude, longitude: inMem.longitude };
    }

    // 2. Check Redis if available
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const res = await redis.hgetall(`driver:location:${driverId}`);
          if (res && res.latitude && res.longitude) {
            const lat = parseFloat(res.latitude);
            const lng = parseFloat(res.longitude);
            if (!isNaN(lat) && !isNaN(lng)) {
              return { latitude: lat, longitude: lng };
            }
          }
        }
      } catch (_) {}
    }

    // 3. Fallback to PostgreSQL
    const dp = await prisma.driverProfile.findUnique({
      where: { id: driverId },
      select: { currentLatitude: true, currentLongitude: true },
    });

    if (dp && dp.currentLatitude != null && dp.currentLongitude != null) {
      return { latitude: dp.currentLatitude, longitude: dp.currentLongitude };
    }

    return null;
  }

  /**
   * Returns a map of all currently cached active driver coordinates.
   * Used for real-time fleet map rendering.
   */
  getAllCachedLocations(): Map<string, DriverLocationData> {
    return new Map(this.memoryCache);
  }

  /**
   * Retrieves real-time driver coordinates across backend instances.
   * Merges local in-memory cache with pipelined Redis cache.
   * If Redis is unavailable, transparently falls back to local memory.
   */
  async getLocationsForDrivers(driverIds: string[]): Promise<Map<string, DriverLocationData>> {
    const resultMap = new Map<string, DriverLocationData>();
    if (!driverIds || driverIds.length === 0) return resultMap;

    // 1. Populate from local in-memory cache first
    for (const id of driverIds) {
      const inMem = this.memoryCache.get(id);
      if (inMem) {
        resultMap.set(id, inMem);
      }
    }

    // 2. If Redis is available, fetch cross-instance locations via pipeline
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const pipeline = redis.pipeline();
          for (const id of driverIds) {
            pipeline.hgetall(`driver:location:${id}`);
          }
          const results = await pipeline.exec();
          if (results) {
            results.forEach(([err, res], idx) => {
              if (!err && res && typeof res === 'object' && Object.keys(res).length > 0) {
                const raw = res as Record<string, string>;
                const id = driverIds[idx];
                const lat = parseFloat(raw.latitude);
                const lng = parseFloat(raw.longitude);
                const version = parseInt(raw.version || '0', 10);
                const updatedAt = parseInt(raw.updatedAt || '0', 10);

                if (!isNaN(lat) && !isNaN(lng)) {
                  const existingMem = resultMap.get(id);
                  // Overwrite if not in memory OR if Redis has a newer or equal version/timestamp
                  if (
                    !existingMem ||
                    version > existingMem.version ||
                    (version === existingMem.version && updatedAt >= existingMem.updatedAt)
                  ) {
                    resultMap.set(id, {
                      driverId: id,
                      userId: raw.userId || existingMem?.userId,
                      latitude: lat,
                      longitude: lng,
                      heading: raw.heading ? parseFloat(raw.heading) : 0,
                      speed: raw.speed ? parseFloat(raw.speed) : 0,
                      accuracy: raw.accuracy ? parseFloat(raw.accuracy) : 0,
                      rideId: raw.rideId || undefined,
                      clientTimestamp: raw.clientTimestamp ? parseInt(raw.clientTimestamp, 10) : undefined,
                      updatedAt: updatedAt || Date.now(),
                      version: version || 1,
                    });
                  }
                }
              }
            });
          }
        }
      } catch (err) {
        // Safe non-blocking fallback: returns whatever is populated in resultMap
      }
    }

    return resultMap;
  }

  /**
   * Resolves driverProfile.id from userId with multi-tier caching (In-Memory -> Redis -> PostgreSQL).
   * Eliminates repetitive database queries on frequent GPS pings while preserving 100% strict driver validation.
   */
  async getDriverIdForUser(userId: string): Promise<string> {
    const now = Date.now();

    // 1. Check local in-memory cache
    const memEntry = this.userToDriverIdCache.get(userId);
    if (memEntry && now - memEntry.cachedAt < this.USER_DRIVER_MAP_TTL_MS) {
      return memEntry.driverId;
    }

    // 2. Check Redis cache if available
    const redisKey = `driver:user_map:${userId}`;
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const cachedId = await redis.get(redisKey);
          if (cachedId) {
            this.userToDriverIdCache.set(userId, { driverId: cachedId, cachedAt: now });
            return cachedId;
          }
        }
      } catch (_) {
        // Safe fallback to database on Redis error
      }
    }

    // 3. Fallback to PostgreSQL
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!driver) {
      throw new Error('Driver profile not found');
    }

    // 4. Populate caches
    this.userToDriverIdCache.set(userId, { driverId: driver.id, cachedAt: now });
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          await redis.set(redisKey, driver.id, 'EX', 86400); // 24 hours TTL
        }
      } catch (_) {}
    }

    return driver.id;
  }

  /**
   * Validates active ride assignment and status with multi-tier caching (In-Memory -> Redis -> PostgreSQL).
   * Eliminates repeated ride lookups on every GPS ping while preserving strict driver ownership
   * and immediate rejection of non-active ride statuses.
   */
  async validateActiveRide(rideId: string, driverId: string): Promise<void> {
    const now = Date.now();
    const activeStatuses = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'];

    // 1. Check local in-memory cache
    const memRide = this.activeRideValidationCache.get(rideId);
    if (memRide && now - memRide.cachedAt < this.RIDE_VALIDATION_TTL_MS) {
      if (memRide.driverId !== driverId) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }
      if (!activeStatuses.includes(memRide.status)) {
        throw new Error(`Cannot update ride location for inactive ride status: ${memRide.status}`);
      }
      return;
    }

    // 2. Check Redis cache if available
    const redisKey = `ride:active_val:${rideId}`;
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const cached = await redis.hgetall(redisKey);
          if (cached && cached.driverId && cached.status && cached.cachedAt) {
            const cachedAt = parseInt(cached.cachedAt, 10);
            if (!isNaN(cachedAt) && now - cachedAt < this.RIDE_VALIDATION_TTL_MS) {
              this.activeRideValidationCache.set(rideId, {
                driverId: cached.driverId,
                status: cached.status,
                cachedAt,
              });
              if (cached.driverId !== driverId) {
                throw new Error('Unauthorized: You are not the assigned driver for this ride');
              }
              if (!activeStatuses.includes(cached.status)) {
                throw new Error(`Cannot update ride location for inactive ride status: ${cached.status}`);
              }
              return;
            }
          }
        }
      } catch (_) {
        // Safe fallback on Redis error
      }
    }

    // 3. Fallback to PostgreSQL
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, driverId: true, status: true },
    });
    if (!ride) {
      throw new Error('Ride not found');
    }
    if (ride.driverId !== driverId) {
      throw new Error('Unauthorized: You are not the assigned driver for this ride');
    }
    if (!activeStatuses.includes(ride.status)) {
      throw new Error(`Cannot update ride location for inactive ride status: ${ride.status}`);
    }

    // 4. Cache valid active ride
    this.activeRideValidationCache.set(rideId, {
      driverId: ride.driverId,
      status: ride.status,
      cachedAt: now,
    });
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const pipeline = redis.pipeline();
          pipeline.hset(redisKey, {
            driverId: ride.driverId,
            status: ride.status,
            cachedAt: String(now),
          });
          pipeline.expire(redisKey, 120); // 2 minutes TTL
          await pipeline.exec();
        }
      } catch (_) {}
    }
  }

  /**
   * Invalidates cached ride validation when ride status changes or terminates.
   * Ensures terminal statuses (COMPLETED, CANCELLED) immediately reject subsequent GPS pings.
   */
  async invalidateRideValidation(rideId: string): Promise<void> {
    this.activeRideValidationCache.delete(rideId);
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          await redis.del(`ride:active_val:${rideId}`);
        }
      } catch (_) {}
    }
  }

  /**
   * Cleans up inactive driver entries from memoryCache to prevent unbounded memory growth.
   * Only evicts records that have already been flushed to PostgreSQL and have had no GPS pings for > maxAgeMs.
   */
  cleanStaleMemoryCache(maxAgeMs = 15 * 60 * 1000): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, entry] of this.memoryCache.entries()) {
      // Never evict dirty records awaiting database flush
      if (this.dirtyDriverIds.has(id)) continue;
      if (now - entry.updatedAt > maxAgeMs) {
        this.memoryCache.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Flushes dirty driver coordinates to PostgreSQL in batches.
   * Avoids concurrent duplicate executions by returning the active flush promise.
   */
  async flushDirtyLocationsToDatabase(): Promise<{ flushedCount: number; failedCount: number }> {
    // If a flush is currently running, return the active flush promise to prevent duplicate concurrency
    if (this.currentFlushPromise) {
      return this.currentFlushPromise;
    }

    this.currentFlushPromise = this.performBatchFlush().finally(() => {
      this.currentFlushPromise = null;
    });

    return this.currentFlushPromise;
  }

  /**
   * Internal execution of batch flush with version tracking and failure isolation.
   */
  private async performBatchFlush(): Promise<{ flushedCount: number; failedCount: number }> {
    const now = Date.now();
    const candidateIds = Array.from(this.dirtyDriverIds);
    if (candidateIds.length === 0) {
      return { flushedCount: 0, failedCount: 0 };
    }

    // 1. Filter out drivers currently in exponential backoff window
    const targetIds: string[] = [];
    for (const id of candidateIds) {
      const failure = this.failureTracking.get(id);
      if (failure && failure.nextRetryAt > now) {
        continue;
      }
      targetIds.push(id);
    }

    if (targetIds.length === 0) {
      return { flushedCount: 0, failedCount: 0 };
    }

    interface FlushSnapshot {
      driverId: string;
      latitude: number;
      longitude: number;
      snapshotVersion: number;
      updatedAt: number;
    }

    const driversToFlush: FlushSnapshot[] = [];
    for (const driverId of targetIds) {
      const entry = this.memoryCache.get(driverId);
      if (entry) {
        const lastFlushed = this.lastFlushedVersion.get(driverId) ?? 0;
        if (entry.version > lastFlushed) {
          driversToFlush.push({
            driverId,
            latitude: entry.latitude,
            longitude: entry.longitude,
            snapshotVersion: entry.version,
            updatedAt: entry.updatedAt,
          });
        } else {
          // Already flushed or equal: clear dirty mark
          this.dirtyDriverIds.delete(driverId);
        }
      } else {
        this.dirtyDriverIds.delete(driverId);
      }
    }

    if (driversToFlush.length === 0) {
      return { flushedCount: 0, failedCount: 0 };
    }

    let flushedCount = 0;
    let failedCount = 0;
    const batchSize = 50;

    for (let i = 0; i < driversToFlush.length; i += batchSize) {
      const chunk = driversToFlush.slice(i, i + batchSize);

      // Re-filter chunk against any immediate flushes that committed in parallel
      const eligibleChunk = chunk.filter(
        (item) => item.snapshotVersion > (this.lastFlushedVersion.get(item.driverId) ?? 0)
      );

      if (eligibleChunk.length === 0) continue;

      try {
        const ops = eligibleChunk.map((item) =>
          prisma.driverProfile.update({
            where: { id: item.driverId },
            data: {
              currentLatitude: item.latitude,
              currentLongitude: item.longitude,
            },
          })
        );

        // Safeguard against unhandled rejections if $transaction fails
        for (const op of ops) {
          if (op && typeof (op as any).catch === 'function') {
            (op as any).catch(() => {});
          }
        }

        // Attempt high-throughput bulk transaction
        await prisma.$transaction(ops);

        // Bulk succeeded: update tracking for all
        for (const item of eligibleChunk) {
          this.lastFlushedVersion.set(item.driverId, item.snapshotVersion);
          this.failureTracking.delete(item.driverId);

          const current = this.memoryCache.get(item.driverId);
          // Only clear dirty if current version still matches the flushed version
          if (!current || current.version <= item.snapshotVersion) {
            this.dirtyDriverIds.delete(item.driverId);
          }
          flushedCount++;
        }

        // Redis dirty set sync if available
        if (isRedisAvailable()) {
          try {
            const redis = getRedisClient();
            if (redis) {
              const cleanIds = eligibleChunk
                .filter((item) => {
                  const curr = this.memoryCache.get(item.driverId);
                  return !curr || curr.version <= item.snapshotVersion;
                })
                .map((item) => item.driverId);
              if (cleanIds.length > 0) {
                await redis.srem('drivers:dirty', ...cleanIds);
              }
            }
          } catch (_) {}
        }
      } catch (bulkErr: any) {
        // Bulk transaction failed: isolate failure by updating individually
        console.warn(
          `[LocationCache] Bulk flush failed for chunk of ${eligibleChunk.length} drivers (${bulkErr?.message}). Falling back to individual updates to isolate failures.`
        );

        for (const item of eligibleChunk) {
          // Re-check version to avoid overwriting newer immediate flush
          if (item.snapshotVersion <= (this.lastFlushedVersion.get(item.driverId) ?? 0)) {
            continue;
          }

          try {
            await prisma.driverProfile.update({
              where: { id: item.driverId },
              data: {
                currentLatitude: item.latitude,
                currentLongitude: item.longitude,
              },
            });

            // Individual update succeeded
            this.lastFlushedVersion.set(item.driverId, item.snapshotVersion);
            this.failureTracking.delete(item.driverId);

            const current = this.memoryCache.get(item.driverId);
            if (!current || current.version <= item.snapshotVersion) {
              this.dirtyDriverIds.delete(item.driverId);
            }
            flushedCount++;

            if (isRedisAvailable()) {
              try {
                const redis = getRedisClient();
                if (redis && (!current || current.version <= item.snapshotVersion)) {
                  await redis.srem('drivers:dirty', item.driverId);
                }
              } catch (_) {}
            }
          } catch (indivErr: any) {
            // This specific driver failed
            failedCount++;
            console.error(
              `[LocationCache] Failed to sync driver ${item.driverId}: ${indivErr?.message}`
            );

            // Exponential backoff to avoid rapid retry loop
            const prev = this.failureTracking.get(item.driverId);
            const count = (prev?.consecutiveFailures ?? 0) + 1;
            const backoffMs = Math.min(60000, 5000 * Math.pow(2, count - 1)); // 5s, 10s, 20s, 40s, 60s
            this.failureTracking.set(item.driverId, {
              consecutiveFailures: count,
              nextRetryAt: Date.now() + backoffMs,
              lastError: indivErr?.message || String(indivErr),
            });
            // Item stays in this.dirtyDriverIds for retry!
          }
        }
      }
    }

    // Periodic eviction of clean inactive driver memory records
    this.cleanStaleMemoryCache();

    return { flushedCount, failedCount };
  }

  /**
   * Immediately flushes a single driver's location to PostgreSQL.
   * Follows the exact same version-ordering rules as batch flush.
   * If a batch flush is currently running, waits for it to complete first
   * so older in-flight batch queries cannot overwrite this immediate write.
   */
  async flushDriverImmediately(driverId: string): Promise<boolean> {
    // Wait for any in-flight batch flush to complete first to guarantee ordering
    if (this.currentFlushPromise) {
      try {
        await this.currentFlushPromise;
      } catch (_) {}
    }

    const entry = this.memoryCache.get(driverId);
    if (!entry) return false;

    const snapshotVersion = entry.version;
    const lastFlushed = this.lastFlushedVersion.get(driverId) ?? 0;
    if (snapshotVersion <= lastFlushed) {
      return true; // Already at or past this version in DB
    }

    try {
      await prisma.driverProfile.update({
        where: { id: driverId },
        data: {
          currentLatitude: entry.latitude,
          currentLongitude: entry.longitude,
        },
      });

      this.lastFlushedVersion.set(driverId, snapshotVersion);
      this.failureTracking.delete(driverId);

      const current = this.memoryCache.get(driverId);
      if (!current || current.version <= snapshotVersion) {
        this.dirtyDriverIds.delete(driverId);
      }

      if (isRedisAvailable()) {
        try {
          const redis = getRedisClient();
          if (redis && (!current || current.version <= snapshotVersion)) {
            await redis.srem('drivers:dirty', driverId);
          }
        } catch (_) {}
      }

      return true;
    } catch (e: any) {
      console.error(`[LocationCache] Error flushing driver ${driverId} immediately:`, e?.message);
      return false;
    }
  }

  /**
   * Synchronized graceful shutdown.
   * 1. Cancels flush timer.
   * 2. Waits for any active flush to complete.
   * 3. Flushes remaining dirty drivers.
   * 4. Enforces a bounded timeout and reports any unflushed records.
   */
  async destroy(timeoutMs = 10000): Promise<{ success: boolean; unflushedCount: number }> {
    this.isDestroyed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const shutdownAction = async () => {
      // 1. Wait for any active in-flight flush to complete
      if (this.currentFlushPromise) {
        try {
          await this.currentFlushPromise;
        } catch (_) {}
      }

      // 2. If there are still dirty drivers, flush them now
      if (this.dirtyDriverIds.size > 0) {
        await this.flushDirtyLocationsToDatabase();
      }
    };

    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });

    const result = await Promise.race([
      shutdownAction().then(() => ({ timedOut: false })),
      timeoutPromise,
    ]);

    if (timeoutId) clearTimeout(timeoutId);

    const unflushedCount = this.dirtyDriverIds.size;
    if (result.timedOut) {
      console.error(
        `[LocationCache] Graceful shutdown flush timed out after ${timeoutMs}ms. Unflushed records: ${unflushedCount}`
      );
      return { success: false, unflushedCount };
    }

    return { success: unflushedCount === 0, unflushedCount };
  }

  // --- Diagnostic and Testing Inspection Helpers ---
  getDirtyCount(): number {
    return this.dirtyDriverIds.size;
  }

  isDriverDirty(driverId: string): boolean {
    return this.dirtyDriverIds.has(driverId);
  }

  getLastFlushedVersion(driverId: string): number {
    return this.lastFlushedVersion.get(driverId) ?? 0;
  }

  getDriverVersion(driverId: string): number {
    return this.memoryCache.get(driverId)?.version ?? 0;
  }

  getFailureInfo(driverId: string): DriverFailureInfo | undefined {
    return this.failureTracking.get(driverId);
  }

  getUserDriverCacheSize(): number {
    return this.userToDriverIdCache.size;
  }

  getActiveRideValidationCacheSize(): number {
    return this.activeRideValidationCache.size;
  }

  clearAll(): void {
    this.memoryCache.clear();
    this.dirtyDriverIds.clear();
    this.lastFlushedVersion.clear();
    this.failureTracking.clear();
    this.userToDriverIdCache.clear();
    this.activeRideValidationCache.clear();
  }
}

export const locationCacheService = new LocationCacheService();
