import { describe, it, expect } from "vitest";
import {
  LegacyAddOrderSchema,
  LegacyOrderStatusSchema,
  LegacyActionSchema,
} from "./legacy.schemas";

describe("Legacy Action Schemas (legacy.schemas.ts)", () => {
  it("should validate valid action property", () => {
    expect(() => LegacyActionSchema.parse({ action: "balance" })).not.toThrow();
    expect(() => LegacyActionSchema.parse({})).toThrow();
  });

  it("should validate standard 'add' order input", () => {
    const validData = {
      action: "add",
      service: 1,
      link: "https://instagram.com/test",
      quantity: 500,
    };

    const parsed = LegacyAddOrderSchema.parse(validData);
    expect(parsed.service).toBe(1);
    expect(parsed.quantity).toBe(500);
    expect(parsed.link).toBe("https://instagram.com/test");
  });

  it("should coerce string inputs in 'add' order input (common in SMM form-data)", () => {
    const stringData = {
      action: "add",
      service: "2",
      link: "https://youtube.com/watch?v=123",
      quantity: "1000",
    };

    const parsed = LegacyAddOrderSchema.parse(stringData);
    expect(parsed.service).toBe(2);
    expect(parsed.quantity).toBe(1000);
  });

  it("should validate drip-feed when both runs and interval are provided", () => {
    const dripfeedData = {
      action: "add",
      service: 1,
      link: "https://instagram.com/test",
      quantity: 1000,
      runs: 5,
      interval: 15,
    };

    const parsed = LegacyAddOrderSchema.parse(dripfeedData);
    expect(parsed.runs).toBe(5);
    expect(parsed.interval).toBe(15);
  });

  it("should reject drip-feed if runs is supplied without interval", () => {
    const invalidDrip = {
      action: "add",
      service: 1,
      link: "https://instagram.com/test",
      quantity: 1000,
      runs: 5,
    };

    expect(() => LegacyAddOrderSchema.parse(invalidDrip)).toThrowError(
      /Both runs and interval are required/,
    );
  });

  it("should reject 'add' order if quantity or service is non-positive or missing", () => {
    expect(() =>
      LegacyAddOrderSchema.parse({
        action: "add",
        service: 1,
        link: "https://test.com",
        quantity: -10,
      }),
    ).toThrow();

    expect(() =>
      LegacyAddOrderSchema.parse({
        action: "add",
        service: 0,
        link: "https://test.com",
        quantity: 100,
      }),
    ).toThrow();
  });

  it("should validate single and multiple order IDs in 'status' action", () => {
    // Single order numeric
    expect(LegacyOrderStatusSchema.parse({ action: "status", order: 32 })).toBeDefined();

    // Single order string
    expect(LegacyOrderStatusSchema.parse({ action: "status", order: "32" })).toBeDefined();

    // Comma-separated order list
    expect(LegacyOrderStatusSchema.parse({ action: "status", order: "32,33,34" })).toBeDefined();

    // Via `orders` field
    expect(LegacyOrderStatusSchema.parse({ action: "status", orders: "32,33" })).toBeDefined();

    // Neither order nor orders
    expect(() => LegacyOrderStatusSchema.parse({ action: "status" })).toThrow();
  });
});
