import { z } from "zod";
import dotenv from "dotenv";

// Load .env file into process.env if available
dotenv.config();

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(""),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  TEST_USER_EMAIL: z.string().email().optional().default("testuser@example.com"),
  TEST_USER_PASSWORD: z.string().optional().default("DevPassword123!Secure"),
  TEST_API_KEY: z.string().optional().default("smm_test_dev_key_0123456789abcdef"),
  TEST_WEBHOOK_SECRET: z.string().optional().default("whsec_dev_test_secret_0123456789abcdef"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(rawEnv: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(rawEnv);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`[Configuration Error] Invalid environment variables:\n${issues}`);
  }

  return parsed.data;
}

export const env: Env = validateEnv();
