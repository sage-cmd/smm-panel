import { describe, it, expect } from "vitest";
import { validateEnv } from "./env";

describe("Environment Configuration (env.ts)", () => {
  it("should parse valid environment variables with default values", () => {
    const validEnv = {
      DATABASE_URL: "postgresql://postgres:password@localhost:5432/smm_test?schema=public",
    };

    const parsed = validateEnv(validEnv);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.REDIS_HOST).toBe("127.0.0.1");
    expect(parsed.REDIS_PORT).toBe(6379);
    expect(parsed.WEBHOOK_TIMEOUT_MS).toBe(5000);
    expect(parsed.WEBHOOK_MAX_RETRIES).toBe(3);
  });

  it("should throw a descriptive configuration error if DATABASE_URL is missing", () => {
    expect(() => validateEnv({ DATABASE_URL: "" })).toThrowError(/DATABASE_URL is required/);
  });

  it("should coerce string numeric port and settings properly", () => {
    const raw = {
      PORT: "8080",
      DATABASE_URL: "postgresql://test:test@localhost:5432/db",
      REDIS_PORT: "6380",
      WEBHOOK_TIMEOUT_MS: "10000",
      WEBHOOK_MAX_RETRIES: "5",
    };

    const parsed = validateEnv(raw);
    expect(parsed.PORT).toBe(8080);
    expect(parsed.REDIS_PORT).toBe(6380);
    expect(parsed.WEBHOOK_TIMEOUT_MS).toBe(10000);
    expect(parsed.WEBHOOK_MAX_RETRIES).toBe(5);
  });
});
