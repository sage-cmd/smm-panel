import crypto from "node:crypto";

export interface WebhookSignatureResult {
  signature: string;
  timestamp: number;
  header: string;
}

/**
 * Signs webhook payload with HMAC-SHA256 and generates timestamp replay-protection header.
 *
 * Header format: t={timestamp},v1={hex_signature}
 * Signature computed over: `${timestamp}.${payloadString}`
 */
export function signWebhookPayload(
  payloadString: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): WebhookSignatureResult {
  const dataToSign = `${timestamp}.${payloadString}`;
  const signature = crypto.createHmac("sha256", secret).update(dataToSign, "utf8").digest("hex");

  const header = `t=${timestamp},v1=${signature}`;

  return {
    signature,
    timestamp,
    header,
  };
}

/**
 * Verifies incoming webhook signature and timestamp freshness.
 */
export function verifyWebhookSignature(
  payloadString: string,
  secret: string,
  signatureHeader: string,
  toleranceSeconds: number = 300, // 5 minutes tolerance
): boolean {
  try {
    const parts = signatureHeader.split(",");
    let timestampStr: string | undefined;
    let signatureHex: string | undefined;

    for (const part of parts) {
      const [key, val] = part.split("=");
      if (key === "t") timestampStr = val;
      if (key === "v1") signatureHex = val;
    }

    if (!timestampStr || !signatureHex) {
      return false;
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return false;
    }

    // Replay protection: check timestamp tolerance
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    // Compute expected signature
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${payloadString}`, "utf8")
      .digest("hex");

    // Timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
