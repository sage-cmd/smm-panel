import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "./app";
import * as prismaLib from "./lib/prisma";
import * as redisLib from "./lib/redis";

vi.mock("./lib/prisma", () => ({
  prisma: {},
  connectPrisma: vi.fn(),
  disconnectPrisma: vi.fn(),
  isPrismaHealthy: vi.fn(),
}));

vi.mock("./lib/redis", () => ({
  isRedisHealthy: vi.fn(),
  disconnectRedis: vi.fn(),
  getRedisClient: vi.fn(),
}));

describe("Express App Foundation (app.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET / should return HTTP 200 and running metadata", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "smm-panel-backend",
      version: "1.0.0",
      status: "running",
    });
  });

  it("GET /health should return HTTP 200 when database is healthy", async () => {
    vi.mocked(prismaLib.isPrismaHealthy).mockResolvedValue(true);
    vi.mocked(redisLib.isRedisHealthy).mockResolvedValue(true);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.services).toEqual({
      database: "connected",
      redis: "connected",
    });
  });

  it("GET /health should return HTTP 503 when database is unhealthy", async () => {
    vi.mocked(prismaLib.isPrismaHealthy).mockResolvedValue(false);
    vi.mocked(redisLib.isRedisHealthy).mockResolvedValue(true);

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.services.database).toBe("disconnected");
  });

  it("should return HTTP 404 for unknown endpoints", async () => {
    const res = await request(app).get("/unknown-route-endpoint");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "error",
      error: {
        code: "NOT_FOUND",
        message: "Endpoint 'GET /unknown-route-endpoint' not found",
      },
    });
  });

  it("should set security headers via helmet", async () => {
    const res = await request(app).get("/");
    expect(res.headers["x-dns-prefetch-control"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
