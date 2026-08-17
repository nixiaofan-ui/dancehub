import Redis from "ioredis";

const url = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

redis.on("error", (err) => {
  if (err.message !== "Connection is closed.") {
    console.warn(`[dancehub] Redis error: ${err.message}`);
  }
});

export async function pingRedis() {
  await redis.ping();
}