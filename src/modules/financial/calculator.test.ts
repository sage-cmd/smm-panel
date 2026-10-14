import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  calculateOrderCharge,
  formatMonetaryAmount,
  distributeDripFeedBatches,
} from "./calculator";

describe("Financial Calculator (calculator.ts)", () => {
  it("should calculate exact order charge with decimal.js without IEEE-754 precision issues", () => {
    // 1000 units at $1.50/1k = $1.500000
    const charge1 = calculateOrderCharge(1000, "1.500000");
    expect(charge1.toString()).toBe("1.5");
    expect(charge1.toFixed(6)).toBe("1.500000");

    // 500 units at $1.50/1k = $0.750000
    const charge2 = calculateOrderCharge(500, "1.500000");
    expect(charge2.toFixed(6)).toBe("0.750000");

    // 1234 units at $3.25/1k = 1.234 * 3.25 = 4.010500
    const charge3 = calculateOrderCharge(1234, "3.250000");
    expect(charge3.toFixed(6)).toBe("4.010500");

    // Micro amounts: 10 units at $0.05/1k = 0.000500
    const charge4 = calculateOrderCharge(10, "0.050000");
    expect(charge4.toFixed(6)).toBe("0.000500");
  });

  it("should format monetary amounts to specified decimal places", () => {
    const val = new Decimal("15.5");
    expect(formatMonetaryAmount(val, 2)).toBe("15.50");
    expect(formatMonetaryAmount(val, 6)).toBe("15.500000");

    const val2 = "100.123456";
    expect(formatMonetaryAmount(val2, 2)).toBe("100.12");
  });

  it("should distribute drip-feed batches evenly and allocate remainder properly", () => {
    const baseDate = new Date("2026-01-01T12:00:00Z");

    // 1. Even distribution: 1000 items, 5 runs, 10 min interval
    const plan1 = distributeDripFeedBatches(1000, 5, 10, baseDate);
    expect(plan1).toHaveLength(5);
    expect(plan1.map((p) => p.quantity)).toEqual([200, 200, 200, 200, 200]);
    expect(plan1.reduce((sum, p) => sum + p.quantity, 0)).toBe(1000);

    // Verify scheduled intervals: 0m, 10m, 20m, 30m, 40m
    expect(plan1[0]?.scheduledAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(plan1[1]?.scheduledAt.toISOString()).toBe("2026-01-01T12:10:00.000Z");
    expect(plan1[4]?.scheduledAt.toISOString()).toBe("2026-01-01T12:40:00.000Z");

    // 2. Remainder distribution: 1003 items, 5 runs (1003 / 5 = 200 base, 3 remainder)
    // First 3 batches get 201, last 2 get 200
    const plan2 = distributeDripFeedBatches(1003, 5, 15, baseDate);
    expect(plan2.map((p) => p.quantity)).toEqual([201, 201, 201, 200, 200]);
    expect(plan2.reduce((sum, p) => sum + p.quantity, 0)).toBe(1003);

    // 3. Remainder distribution: 1001 items, 3 runs (1001 / 3 = 333 base, 2 remainder)
    // First 2 batches get 334, last gets 333
    const plan3 = distributeDripFeedBatches(1001, 3, 5, baseDate);
    expect(plan3.map((p) => p.quantity)).toEqual([334, 334, 333]);
    expect(plan3.reduce((sum, p) => sum + p.quantity, 0)).toBe(1001);
  });
});
