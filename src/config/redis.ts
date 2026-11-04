import Redis from 'ioredis';

let redisClient: Redis | null = null;
let isConnected = false;
let connectionAttempted = false;

/**
 * Initializes Redis client with graceful fallback.
 * If Redis server is not reachable, the system logs a notice and continues
 * with the zero-downtime In-Memory Location Cache.
 */
export function initRedis(): Redis | null {
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  try {
    redisClient = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => {
        // Retry at most 2 times on startup, then stop to avoid log spam if Redis is not installed
        if (times <= 2) return 1000;
        return null;
      },
    });

    redisClient.on('connect', () => {
      isConnected = true;
      console.log(`[Redis] Connected successfully to ${redisUrl}`);
    });

    redisClient.on('ready', () => {
      isConnected = true;
    });

    redisClient.on('close', () => {
      isConnected = false;
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      if (!connectionAttempted) {
        connectionAttempted = true;
        console.log(
          `[Redis] Standalone Redis not detected at ${redisUrl}. Using High-Performance In-Memory Location Cache with periodic PostgreSQL batch dump.`
        );
      }
    });

    // Attempt initial non-blocking connection
    redisClient.connect().catch(() => {
      isConnected = false;
      if (!connectionAttempted) {
        connectionAttempted = true;
        console.log(
          `[Redis] Standalone Redis not detected at ${redisUrl}. Using High-Performance In-Memory Location Cache with periodic PostgreSQL batch dump.`
        );
      }
    });

    return redisClient;
  } catch (e) {
    isConnected = false;
    console.log(
      `[Redis] Initialization skipped. Using High-Performance In-Memory Location Cache with periodic PostgreSQL batch dump.`
    );
    return null;
  }
}

/**
 * Returns the Redis client instance if initialized.
 */
export function getRedisClient(): Redis | null {
  if (!redisClient) {
    return initRedis();
  }
  return redisClient;
}

/**
 * Checks whether Redis is currently reachable and ready.
 */
export function isRedisAvailable(): boolean {
  return isConnected && redisClient !== null && redisClient.status === 'ready';
}

/**
 * Gracefully disconnects the Redis client.
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (_) {
      redisClient.disconnect();
    }
    redisClient = null;
    isConnected = false;
  }
}
