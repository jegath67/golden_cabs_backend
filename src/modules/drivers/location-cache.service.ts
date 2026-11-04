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
  updatedAt: number;
}

export class LocationCacheService {
  private memoryCache = new Map<string, DriverLocationData>();
  private dirtyDriverIds = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private flushIntervalMs = 5000; // Flush to PostgreSQL every 5 seconds

  /**
   * Initializes the background batch flush timer.
   */
  init(intervalMs = 5000) {
    this.flushIntervalMs = intervalMs;
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
   * This operates in sub-millisecond time and eliminates PostgreSQL disk write locks on every ping.
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
    }
  ): Promise<DriverLocationData> {
    const locationEntry: DriverLocationData = {
      driverId,
      userId: data.userId,
      latitude: data.latitude,
      longitude: data.longitude,
      heading: data.heading,
      speed: data.speed,
      accuracy: data.accuracy,
      rideId: data.rideId,
      updatedAt: Date.now(),
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
            latitude: String(data.latitude),
            longitude: String(data.longitude),
            heading: String(data.heading ?? 0),
            speed: String(data.speed ?? 0),
            accuracy: String(data.accuracy ?? 0),
            rideId: data.rideId || '',
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
    if (inMem && inMem.latitude && inMem.longitude) {
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
   * Flushes all dirty driver coordinates from memory/Redis to PostgreSQL in a batched transaction.
   */
  async flushDirtyLocationsToDatabase(): Promise<{ flushedCount: number }> {
    if (this.isFlushing) {
      return { flushedCount: 0 };
    }

    let driversToFlush: DriverLocationData[] = [];

    // Gathers dirty IDs from memory
    const targetIds = Array.from(this.dirtyDriverIds);
    if (targetIds.length === 0) {
      return { flushedCount: 0 };
    }

    for (const driverId of targetIds) {
      const entry = this.memoryCache.get(driverId);
      if (entry) {
        driversToFlush.push(entry);
      }
    }

    if (driversToFlush.length === 0) {
      return { flushedCount: 0 };
    }

    this.isFlushing = true;
    try {
      // Chunk updates into batches of 50 to avoid exceeding PostgreSQL parameter limits
      const batchSize = 50;
      for (let i = 0; i < driversToFlush.length; i += batchSize) {
        const chunk = driversToFlush.slice(i, i + batchSize);
        await prisma.$transaction(
          chunk.map((item) =>
            prisma.driverProfile.update({
              where: { id: item.driverId },
              data: {
                currentLatitude: item.latitude,
                currentLongitude: item.longitude,
              },
            })
          )
        );
      }

      // Remove flushed drivers from dirty tracking
      for (const d of driversToFlush) {
        this.dirtyDriverIds.delete(d.driverId);
      }

      // Remove from Redis dirty set if available
      if (isRedisAvailable()) {
        try {
          const redis = getRedisClient();
          if (redis && driversToFlush.length > 0) {
            await redis.srem('drivers:dirty', ...driversToFlush.map((d) => d.driverId));
          }
        } catch (_) {}
      }

      return { flushedCount: driversToFlush.length };
    } catch (err) {
      console.error('[LocationCache] Failed to batch flush driver locations to DB:', err);
      return { flushedCount: 0 };
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Immediately flushes a single driver's location to PostgreSQL.
   * Used when driver shift ends (going offline) or active ride completes.
   */
  async flushDriverImmediately(driverId: string): Promise<void> {
    const entry = this.memoryCache.get(driverId);
    if (!entry) return;

    try {
      await prisma.driverProfile.update({
        where: { id: driverId },
        data: {
          currentLatitude: entry.latitude,
          currentLongitude: entry.longitude,
        },
      });
      this.dirtyDriverIds.delete(driverId);

      if (isRedisAvailable()) {
        try {
          const redis = getRedisClient();
          if (redis) {
            await redis.srem('drivers:dirty', driverId);
          }
        } catch (_) {}
      }
    } catch (e) {
      console.error(`[LocationCache] Error flushing driver ${driverId} immediately:`, e);
    }
  }

  /**
   * Cleans up on application shutdown.
   */
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush of any pending updates
    await this.flushDirtyLocationsToDatabase();
  }
}

export const locationCacheService = new LocationCacheService();
