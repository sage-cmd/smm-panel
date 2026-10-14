import { describe, it, expect } from "vitest";
import { parsePaginationParams, formatPaginationMeta } from "./pagination";

describe("Pagination Utility (pagination.ts)", () => {
  it("should parse default pagination parameters when query is empty", () => {
    const params = parsePaginationParams({});
    expect(params.page).toBe(1);
    expect(params.limit).toBe(20);
    expect(params.skip).toBe(0);
  });

  it("should parse custom page and limit correctly", () => {
    const params = parsePaginationParams({ page: "3", limit: "15" });
    expect(params.page).toBe(3);
    expect(params.limit).toBe(15);
    expect(params.skip).toBe(30); // (3 - 1) * 15 = 30
  });

  it("should enforce maximum limit ceiling", () => {
    const params = parsePaginationParams({ page: "1", limit: "500" }, 20, 100);
    expect(params.limit).toBe(100);
  });

  it("should handle non-numeric or negative values safely", () => {
    const params = parsePaginationParams({ page: "-5", limit: "invalid" });
    expect(params.page).toBe(1);
    expect(params.limit).toBe(20);
  });

  it("should format pagination metadata accurately", () => {
    const meta = formatPaginationMeta(45, 1, 20);
    expect(meta).toEqual({
      page: 1,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });

    const lastPageMeta = formatPaginationMeta(45, 3, 20);
    expect(lastPageMeta.hasNext).toBe(false);
    expect(lastPageMeta.hasPrev).toBe(true);
  });
});
