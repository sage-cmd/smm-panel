import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { authenticateApiKey } from "./auth";
import { prisma } from "../lib/prisma";
import { UnauthorizedError } from "../errors/AppError";

vi.mock("../lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe("Authentication Middleware (auth.ts)", () => {
  const rawKey = "smm_test_secret_key_12345";
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const mockUser = {
    id: "user-uuid-1",
    email: "test@example.com",
    passwordHash: "hashed",
    balance: "100.000000",
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockApiKey = {
    id: "api-key-uuid-1",
    userId: mockUser.id,
    keyHash,
    keyPrefix: "smm_test...",
    name: "Test Key",
    isActive: true,
    createdAt: new Date(),
    lastUsedAt: null,
    user: mockUser,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should authenticate successfully with valid 'Authorization: Bearer <key>' header", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKey as any);

    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
      body: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash },
      include: { user: true },
    });
    expect(req.user).toEqual(mockUser);
    expect(req.apiKey).toEqual(mockApiKey);
    expect(next).toHaveBeenCalledWith();
  });

  it("should reject request when Authorization header is malformed and NOT fall back to body key", async () => {
    const req = {
      headers: { authorization: "Basic some_basic_token" },
      body: { key: rawKey }, // Valid body key present, but must be ignored!
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = vi.mocked(next).mock.calls[0]?.[0] as unknown as UnauthorizedError;
    expect(error.message).toMatch(/Invalid Authorization header format/);
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("should reject request when Bearer token is empty in Authorization header", async () => {
    const req = {
      headers: { authorization: "Bearer   " },
      body: { key: rawKey },
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("should fall back to body 'key' when Authorization header is absent", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKey as any);

    const req = {
      headers: {}, // No authorization header
      body: { key: rawKey },
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash },
      include: { user: true },
    });
    expect(req.user).toEqual(mockUser);
    expect(req.apiKey).toEqual(mockApiKey);
    expect(next).toHaveBeenCalledWith();
  });

  it("should reject when both Authorization header and body key are absent", async () => {
    const req = {
      headers: {},
      body: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = vi.mocked(next).mock.calls[0]?.[0] as unknown as UnauthorizedError;
    expect(error.message).toMatch(/Authentication credentials missing/);
  });

  it("should reject when API key is not found in database", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null);

    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
      body: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = vi.mocked(next).mock.calls[0]?.[0] as unknown as UnauthorizedError;
    expect(error.message).toBe("Invalid API key");
  });

  it("should reject when API key is deactivated (isActive = false)", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockApiKey,
      isActive: false,
    } as any);

    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
      body: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = vi.mocked(next).mock.calls[0]?.[0] as unknown as UnauthorizedError;
    expect(error.message).toBe("API key has been deactivated");
  });

  it("should reject when user account associated with key is missing", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      ...mockApiKey,
      user: null,
    } as any);

    const req = {
      headers: { authorization: `Bearer ${rawKey}` },
      body: {},
    } as unknown as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = vi.mocked(next).mock.calls[0]?.[0] as unknown as UnauthorizedError;
    expect(error.message).toBe("Associated user account not found");
  });
});
