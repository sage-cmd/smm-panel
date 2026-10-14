import { describe, it, expect } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "./webhookSignature";

describe("Webhook Signature & Verification (webhookSignature.ts)", () => {
  const secret = "whsec_test_secret_key_1234567890";
  const payload = JSON.stringify({
    event: "order.completed",
    order_id: 42,
    status: "completed",
    remains: 0,
  });

  it("should generate a valid signature header in format t={timestamp},v1={hash}", () => {
    const timestamp = 1700000000;
    const result = signWebhookPayload(payload, secret, timestamp);

    expect(result.timestamp).toBe(timestamp);
    expect(result.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(result.header).toBe(`t=${timestamp},v1=${result.signature}`);
  });

  it("should verify a matching signature header within tolerance window", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = signWebhookPayload(payload, secret, now);

    const isValid = verifyWebhookSignature(payload, secret, result.header, 300);
    expect(isValid).toBe(true);
  });

  it("should reject verification when the payload has been tampered with", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = signWebhookPayload(payload, secret, now);

    const tamperedPayload = JSON.stringify({
      event: "order.completed",
      order_id: 42,
      status: "completed",
      remains: 9999, // tampered value
    });

    const isValid = verifyWebhookSignature(tamperedPayload, secret, result.header, 300);
    expect(isValid).toBe(false);
  });

  it("should reject verification when secret does not match", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = signWebhookPayload(payload, secret, now);

    const wrongSecret = "whsec_wrong_secret_key";
    const isValid = verifyWebhookSignature(payload, wrongSecret, result.header, 300);
    expect(isValid).toBe(false);
  });

  it("should reject expired signatures to prevent replay attacks", () => {
    // Timestamp from 10 minutes ago (> 300s tolerance)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const result = signWebhookPayload(payload, secret, oldTimestamp);

    const isValid = verifyWebhookSignature(payload, secret, result.header, 300);
    expect(isValid).toBe(false);
  });

  it("should reject malformed signature headers gracefully without throwing", () => {
    expect(verifyWebhookSignature(payload, secret, "invalid_header")).toBe(false);
    expect(verifyWebhookSignature(payload, secret, "t=notanumber,v1=abc")).toBe(false);
    expect(verifyWebhookSignature(payload, secret, "")).toBe(false);
  });
});
