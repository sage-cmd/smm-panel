import { describe, it, expect } from "vitest";
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalServerError,
} from "./AppError";

describe("Domain Error Classes (AppError.ts)", () => {
  it("should create AppError with custom properties", () => {
    const error = new AppError("Custom error", 418, "TEAPOT", true, { detail: "info" });
    expect(error.message).toBe("Custom error");
    expect(error.statusCode).toBe(418);
    expect(error.code).toBe("TEAPOT");
    expect(error.isOperational).toBe(true);
    expect(error.details).toEqual({ detail: "info" });
  });

  it("should create BadRequestError with status 400", () => {
    const error = new BadRequestError("Invalid param");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("should create UnauthorizedError with status 401", () => {
    const error = new UnauthorizedError();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("should create ForbiddenError with status 403", () => {
    const error = new ForbiddenError();
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
  });

  it("should create NotFoundError with status 404", () => {
    const error = new NotFoundError("User missing");
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
  });

  it("should create ConflictError with status 409", () => {
    const error = new ConflictError("Email already in use");
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CONFLICT");
  });

  it("should create ValidationError with status 400 and code VALIDATION_ERROR", () => {
    const error = new ValidationError("Schema failed", [{ field: "amount", message: "Required" }]);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toBeDefined();
  });

  it("should create InternalServerError with status 500 and isOperational=false", () => {
    const error = new InternalServerError();
    expect(error.statusCode).toBe(500);
    expect(error.isOperational).toBe(false);
  });
});
