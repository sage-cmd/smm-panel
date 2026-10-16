import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import {
  callSupplierRefill,
  callSupplierRefillStatus,
  pollInFlightRefills,
  expireGuarantees,
  requestRefills,
  executeRefillCycle,
  SupplierRefillResponseSchema,
  SupplierRefillStatusResponseSchema,
} from "./refillWorker";
import { prisma } from "../lib/prisma";
import { RefillStatus, RefillLogStatus, OrderStatus } from "@prisma/client";
import { AdminCreateServiceSchema } from "../modules/admin/admin.schemas";

vi.mock("axios");

vi.mock("../lib/prisma", () => {
  const mockTx = {
    order: {
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    refillLog: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    service: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };

  return {
    prisma: {
      ...mockTx,
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    },
  };
});

vi.mock("../lib/redis", () => ({
  redisOptions: {},
  isRedisHealthy: vi.fn().mockResolvedValue(true),
}));

describe("Auto-Refill Worker (refillWorker.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockSupplier = {
    id: 1,
    name: "Primary SMM Provider",
    apiUrl: "https://api.supplier.com/v2",
    apiKey: "secret_api_key_supplier_1",
    isActive: true,
  };

  const mockService = {
    id: 10,
    name: "Instagram Followers (30d Refill)",
    refillEnabled: true,
    refillPeriodDays: 30,
    supplierId: 1,
    supplier: mockSupplier,
  };

  describe("1. Zod Response Validation", () => {
    it("should parse string and number refill IDs correctly", () => {
      const parsedString = SupplierRefillResponseSchema.parse({ refill: "ref_1001" });
      expect(parsedString).toEqual({ refill: "ref_1001" });

      const parsedNum = SupplierRefillResponseSchema.parse({ refill: 1002 });
      expect(parsedNum).toEqual({ refill: "1002" });
    });

    it("should parse supplier error message as normal outcome", () => {
      const parsedError = SupplierRefillResponseSchema.parse({ error: "No drop detected yet" });
      expect(parsedError).toEqual({ error: "No drop detected yet" });
    });

    it("should parse valid refill statuses", () => {
      expect(SupplierRefillStatusResponseSchema.parse({ status: "Completed" })).toEqual({
        status: "Completed",
      });
      expect(SupplierRefillStatusResponseSchema.parse({ status: "In progress" })).toEqual({
        status: "In progress",
      });
      expect(SupplierRefillStatusResponseSchema.parse({ status: "Rejected" })).toEqual({
        status: "Rejected",
      });
    });
  });

  describe("2. HTTP Supplier Calls (callSupplierRefill & callSupplierRefillStatus)", () => {
    it("should never auto-retry refill POST and return parsed response", async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { refill: "ref_555" },
      });

      const res = await callSupplierRefill("https://api.test/v2", "key-123", "ext_order_1");
      expect(res).toEqual({ refill: "ref_555" });
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        "https://api.test/v2",
        {
          key: "key-123",
          action: "refill",
          order: "ext_order_1",
        },
        expect.objectContaining({ timeout: 10000 }),
      );
    });

    it("should return error object on network failure without throwing", async () => {
      vi.mocked(axios.post).mockRejectedValueOnce(
        new Error("ETIMEDOUT gateway connection dropped"),
      );

      const res = await callSupplierRefill("https://api.test/v2", "key-123", "ext_order_1");
      expect(res).toEqual({ error: "ETIMEDOUT gateway connection dropped" });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it("should retry refill_status on transient failures up to maxRetries", async () => {
      vi.mocked(axios.post)
        .mockRejectedValueOnce(new Error("Socket hang up"))
        .mockResolvedValueOnce({
          status: 200,
          data: { status: "Completed" },
        });

      const res = await callSupplierRefillStatus("https://api.test/v2", "key-123", "ref_555", 2);
      expect(res).toEqual({ status: "Completed" });
      expect(axios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe("3. Step A: Poll In-Flight Refills (orders with refillStatus = REFILLING)", () => {
    const mockRefillingOrder = {
      id: 201,
      userId: "user-1",
      serviceId: 10,
      externalOrderId: "ext_201",
      refillStatus: RefillStatus.REFILLING,
      activeRefillId: "supplier_refill_99",
      service: mockService,
    };

    it("should transition order to WAITING and RefillLog to SUCCESS when supplier reports Completed", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockRefillingOrder as any]);
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { status: "Completed" },
      });

      const count = await pollInFlightRefills(false);
      expect(count).toBe(1);

      expect(prisma.refillLog.updateMany).toHaveBeenCalledWith({
        where: {
          orderId: 201,
          supplierRefillId: "supplier_refill_99",
          status: RefillLogStatus.PENDING,
        },
        data: { status: RefillLogStatus.SUCCESS },
      });

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 201 },
        data: {
          refillStatus: RefillStatus.WAITING,
          activeRefillId: null,
          lastRefillCheck: expect.any(Date),
        },
      });
    });

    it("should transition order to WAITING and RefillLog to FAILED when supplier reports Rejected", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockRefillingOrder as any]);
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { status: "Rejected" },
      });

      await pollInFlightRefills(false);

      expect(prisma.refillLog.updateMany).toHaveBeenCalledWith({
        where: {
          orderId: 201,
          supplierRefillId: "supplier_refill_99",
          status: RefillLogStatus.PENDING,
        },
        data: {
          status: RefillLogStatus.FAILED,
          errorMessage: "Supplier reported status: Rejected",
        },
      });

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 201 },
        data: {
          refillStatus: RefillStatus.WAITING,
          activeRefillId: null,
          lastRefillCheck: expect.any(Date),
        },
      });
    });

    it("should leave order as REFILLING when supplier reports In progress", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockRefillingOrder as any]);
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { status: "In progress" },
      });

      await pollInFlightRefills(false);

      expect(prisma.refillLog.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 201 },
        data: { lastRefillCheck: expect.any(Date) },
      });
    });

    it("should not invoke supplier HTTP calls in dry-run mode", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockRefillingOrder as any]);

      await pollInFlightRefills(true);

      expect(axios.post).not.toHaveBeenCalled();
      expect(prisma.refillLog.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("4. Step B: Expire Old Guarantees (refillStatus = WAITING and refillExpiresAt < now)", () => {
    it("should mark expired orders as COMPLETED", async () => {
      vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 4 });

      const expired = await expireGuarantees(false);
      expect(expired).toBe(4);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          refillStatus: RefillStatus.WAITING,
          refillExpiresAt: { lt: expect.any(Date) },
        },
        data: {
          refillStatus: RefillStatus.COMPLETED,
        },
      });
    });

    it("should only count and not mutate orders in dry-run mode", async () => {
      vi.mocked(prisma.order.count).mockResolvedValue(3);

      const count = await expireGuarantees(true);
      expect(count).toBe(3);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("5. Step C: Request Refills", () => {
    const mockWaitingOrder = {
      id: 301,
      userId: "user-2",
      serviceId: 10,
      externalOrderId: "ext_301",
      refillStatus: RefillStatus.WAITING,
      refillExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // active for 10 more days
      status: OrderStatus.COMPLETED,
      service: mockService,
    };

    it("should create RefillLog (PENDING) FIRST then request supplier refill on success", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockWaitingOrder as any]);
      vi.mocked(prisma.refillLog.create).mockResolvedValue({
        id: "refill-log-uuid-1",
        orderId: 301,
        status: RefillLogStatus.PENDING,
      } as any);

      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { refill: "sup_refill_888" },
      });

      const count = await requestRefills(false);
      expect(count).toBe(1);

      // Verify RefillLog was created FIRST with PENDING
      expect(prisma.refillLog.create).toHaveBeenCalledWith({
        data: {
          orderId: 301,
          status: RefillLogStatus.PENDING,
        },
      });

      // Verify supplier was called once
      expect(axios.post).toHaveBeenCalledTimes(1);

      // Verify RefillLog updated with supplier refill ID
      expect(prisma.refillLog.update).toHaveBeenCalledWith({
        where: { id: "refill-log-uuid-1" },
        data: {
          supplierRefillId: "sup_refill_888",
          status: RefillLogStatus.PENDING,
        },
      });

      // Verify Order transitioned to REFILLING and activeRefillId set
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 301 },
        data: {
          refillStatus: RefillStatus.REFILLING,
          refillCount: { increment: 1 },
          activeRefillId: "sup_refill_888",
          lastRefillCheck: expect.any(Date),
        },
      });
    });

    it("should mark RefillLog as FAILED and leave order WAITING when supplier rejects with error", async () => {
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockWaitingOrder as any]);
      vi.mocked(prisma.refillLog.create).mockResolvedValue({
        id: "refill-log-uuid-2",
        orderId: 301,
        status: RefillLogStatus.PENDING,
      } as any);

      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { error: "No drop yet for this order" },
      });

      await requestRefills(false);

      expect(prisma.refillLog.update).toHaveBeenCalledWith({
        where: { id: "refill-log-uuid-2" },
        data: {
          status: RefillLogStatus.FAILED,
          errorMessage: "No drop yet for this order",
        },
      });

      // Order stays in WAITING
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 301 },
        data: {
          lastRefillCheck: expect.any(Date),
        },
      });
    });
  });

  describe("6. Full 24h Refill Cycle Execution", () => {
    it("should execute Phase A, Phase B, and Phase C sequentially", async () => {
      vi.mocked(prisma.order.findMany)
        .mockResolvedValueOnce([]) // Phase A in-flight
        .mockResolvedValueOnce([]); // Phase C waiting
      vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 }); // Phase B

      const summary = await executeRefillCycle(false);
      expect(summary.polled).toBe(0);
      expect(summary.expired).toBe(0);
      expect(summary.requested).toBe(0);
      expect(summary.dryRun).toBe(false);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("7. Service Refill Zod Validation", () => {
    it("should reject refillEnabled: true when refillPeriodDays is missing or zero", () => {
      const invalidNoPeriod = {
        name: "Test Refill",
        category: "Instagram",
        ratePer1000: "2.5",
        minQuantity: 100,
        maxQuantity: 1000,
        refillEnabled: true,
      };

      const result = AdminCreateServiceSchema.safeParse(invalidNoPeriod);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("refillPeriodDays is required");
      }
    });

    it("should accept refillEnabled: true when refillPeriodDays > 0", () => {
      const valid = {
        name: "Test Refill",
        category: "Instagram",
        ratePer1000: "2.5",
        minQuantity: 100,
        maxQuantity: 1000,
        refillEnabled: true,
        refillPeriodDays: 30,
      };

      const result = AdminCreateServiceSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });
});
