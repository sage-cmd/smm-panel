import { describe, it, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { ZodError, z } from "zod";
import { Prisma } from "@prisma/client";
import { errorHandler } from "./errorHandler";
import { BadRequestError, NotFoundError } from "../errors/AppError";

function createMockReqRes(originalUrl = "/api/v1/rest/orders") {
  const req = {
    originalUrl,
    method: "GET",
  } as unknown as Request;

  const res = {
    statusCode: 200,
    status: vi.fn().mockImplementation(function (this: Response, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}

describe("Centralized Error Handler (errorHandler.ts)", () => {
  it("should format AppError in REST API standard format with appropriate status code", () => {
    const { req, res, next } = createMockReqRes("/api/v1/rest/orders/123");
    const err = new NotFoundError("Order #123 not found");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      error: {
        code: "NOT_FOUND",
        message: "Order #123 not found",
      },
    });
  });

  it("should format AppError in legacy compatibility format (HTTP 200 with { error: msg })", () => {
    const { req, res, next } = createMockReqRes("/api/v1");
    const err = new BadRequestError("Incorrect order ID");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      error: "Incorrect order ID",
    });
  });

  it("should handle ZodError and return structured 400 response for REST endpoints", () => {
    const { req, res, next } = createMockReqRes("/api/v1/rest/orders");
    const schema = z.object({
      quantity: z.number().min(100),
    });

    let zodErr: ZodError | null = null;
    try {
      schema.parse({ quantity: 10 });
    } catch (e) {
      zodErr = e as ZodError;
    }

    errorHandler(zodErr!, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: "Invalid request payload",
        }),
      }),
    );
  });

  it("should handle Prisma P2002 unique constraint error as 409 Conflict", () => {
    const { req, res, next } = createMockReqRes("/api/v1/rest/users");
    const prismaErr = new Prisma.PrismaClientKnownRequestError("Unique violation", {
      code: "P2002",
      clientVersion: "6.4.1",
      meta: { target: ["email"] },
    });

    errorHandler(prismaErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      status: "error",
      error: {
        code: "CONFLICT",
        message: "A record with this email already exists.",
      },
    });
  });

  it("should handle unhandled unexpected errors with 500 status", () => {
    const { req, res, next } = createMockReqRes("/api/v1/rest/balance");
    const genericErr = new Error("Database network drop");

    errorHandler(genericErr, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error: expect.objectContaining({
          code: "INTERNAL_SERVER_ERROR",
        }),
      }),
    );
  });
});
