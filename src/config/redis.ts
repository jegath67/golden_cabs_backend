import Redis from 'ioredis';

let redisClient: Redis | null = null;
let isConnected = false;
let hasLoggedOfflineWarning = false;

/**
 * Calculates controlled exponential backoff with maximum delay cap and jitter.
 * Prevents rapid retry loops while ensuring recovery after arbitrary outage durations.
 */
export function calculateRedisBackoffDelay(times: number): number {
  // times: 1, 2, 3...
  // 1st: 1000ms, 2nd: 1500ms, 3rd: 2250ms, 4th: 3375ms, 5th: 5062ms...
  // Capped at 15,000ms (15 seconds) + up to 500ms jitter.
  const baseDelay = Math.min(1000 * Math.pow(1.5, Math.min(times - 1, 8)), 15000);
  const jitter = Math.floor(Math.random() * 500);
  return Math.floor(baseDelay + jitter);
}

/**
 * Initializes Redis client with graceful fallback and non-terminating exponential backoff.
 * If Redis server is not reachable, the system logs a controlled notice and continues
 * with the zero-downtime In-Memory Location Cache while background reconnection remains active.
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
        return calculateRedisBackoffDelay(times);
      },
    });

    redisClient.on('connect', () => {
      isConnected = true;
      if (hasLoggedOfflineWarning) {
        console.log(`[Redis] Reconnected successfully to ${redisUrl}`);
      } else {
        console.log(`[Redis] Connected successfully to ${redisUrl}`);
      }
      hasLoggedOfflineWarning = false;
    });

    redisClient.on('ready', () => {
      isConnected = true;
    });

    redisClient.on('close', () => {
      isConnected = false;
    });

    redisClient.on('error', (err) => {
      isConnected = false;
      if (!hasLoggedOfflineWarning) {
        hasLoggedOfflineWarning = true;
        console.warn(
          `[Redis] Redis unavailable at ${redisUrl} (${err?.message || 'Connection refused'}). Falling back to In-Memory Location Cache with background reconnection active.`
        );
      }
    });

    // Attempt initial non-blocking connection
    redisClient.connect().catch((err) => {
      isConnected = false;
      if (!hasLoggedOfflineWarning) {
        hasLoggedOfflineWarning = true;
        console.warn(
          `[Redis] Redis unavailable at ${redisUrl} (${err?.message || 'Connection refused'}). Falling back to In-Memory Location Cache with background reconnection active.`
        );
      }
    });

    return redisClient;
  } catch (e) {
    isConnected = false;
    console.warn(
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
    hasLoggedOfflineWarning = false;
  }
}

/**
 * Diagnostic and testing helper to inject mock Redis client or simulate connectivity state.
 */
export function setRedisClientForTest(client: Redis | null, connected = false): void {
  redisClient = client;
  isConnected = connected;
}
