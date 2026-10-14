import { env } from "../config/env";

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "key",
  "apikey",
  "secret",
  "authorization",
  "token",
  "cookie",
  "x-webhook-signature",
]);

/**
 * Recursively redacts sensitive keys in objects and strings before logging.
 */
export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // Redact Bearer tokens in plain strings
    return data.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }

  if (typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = redactSensitiveData(value);
      }
    }
    return sanitized;
  }

  return data;
}

type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const sanitizedMeta = meta !== undefined ? redactSensitiveData(meta) : undefined;

    if (env.NODE_ENV === "production") {
      return JSON.stringify({
        timestamp,
        level,
        message,
        ...(sanitizedMeta !== undefined ? { meta: sanitizedMeta } : {}),
      });
    }

    const metaStr = sanitizedMeta !== undefined ? ` ${JSON.stringify(sanitizedMeta, null, 2)}` : "";
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  public debug(message: string, meta?: unknown): void {
    if (env.NODE_ENV !== "production") {
      console.debug(this.formatMessage("debug", message, meta));
    }
  }

  public info(message: string, meta?: unknown): void {
    console.info(this.formatMessage("info", message, meta));
  }

  public warn(message: string, meta?: unknown): void {
    console.warn(this.formatMessage("warn", message, meta));
  }

  public error(message: string, meta?: unknown): void {
    console.error(this.formatMessage("error", message, meta));
  }
}

export const logger = new Logger();
