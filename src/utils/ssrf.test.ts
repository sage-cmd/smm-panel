import { describe, it, expect } from "vitest";
import { validateWebhookUrl } from "./ssrf";

describe("SSRF URL Validator (ssrf.ts)", () => {
  it("should allow valid public HTTPS and HTTP URLs", () => {
    expect(validateWebhookUrl("https://example.com/webhook")).toBe(true);
    expect(validateWebhookUrl("https://webhook.site/01234567-89ab-cdef")).toBe(true);
    expect(validateWebhookUrl("https://api.myclient.org/v1/events")).toBe(true);
    expect(validateWebhookUrl("http://public-endpoint.io/receiver")).toBe(true);
  });

  it("should block loopback hosts (localhost, 127.0.0.1, ::1)", () => {
    expect(validateWebhookUrl("http://localhost:3000/webhook")).toBe(false);
    expect(validateWebhookUrl("https://app.localhost/hook")).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.1:8080/callback")).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.2/hook")).toBe(false);
  });

  it("should block private IPv4 network ranges", () => {
    // 10.0.0.0/8
    expect(validateWebhookUrl("http://10.0.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("http://10.254.1.5:9000")).toBe(false);

    // 172.16.0.0/12
    expect(validateWebhookUrl("http://172.16.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("http://172.31.255.255/hook")).toBe(false);

    // 192.168.0.0/16
    expect(validateWebhookUrl("http://192.168.1.1/hook")).toBe(false);
    expect(validateWebhookUrl("http://192.168.0.100:8000")).toBe(false);

    // 0.0.0.0
    expect(validateWebhookUrl("http://0.0.0.0:4000")).toBe(false);

    // 100.64.0.0/10 (Carrier grade NAT)
    expect(validateWebhookUrl("http://100.64.0.1/hook")).toBe(false);
  });

  it("should block cloud metadata and link-local destinations", () => {
    // AWS / Azure / GCP Metadata IP
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(validateWebhookUrl("http://169.254.0.1/api")).toBe(false);

    // GCP internal metadata domain
    expect(validateWebhookUrl("http://metadata.google.internal/computeMetadata/v1")).toBe(false);
  });

  it("should block non-HTTP protocols", () => {
    expect(validateWebhookUrl("ftp://example.com/file")).toBe(false);
    expect(validateWebhookUrl("file:///etc/passwd")).toBe(false);
    expect(validateWebhookUrl("gopher://example.com")).toBe(false);
  });
});
