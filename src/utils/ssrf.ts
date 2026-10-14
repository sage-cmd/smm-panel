import net from "node:net";

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, or reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [p0, p1] = parts;
  if (p0 === undefined || p1 === undefined) return true;

  // 127.0.0.0/8 (Loopback)
  if (p0 === 127) return true;

  // 10.0.0.0/8 (Private)
  if (p0 === 10) return true;

  // 172.16.0.0/12 (Private)
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (p0 === 192 && p1 === 168) return true;

  // 169.254.0.0/16 (Link-local & Cloud Metadata: AWS/GCP/Azure 169.254.169.254)
  if (p0 === 169 && p1 === 254) return true;

  // 0.0.0.0/8 (Current network)
  if (p0 === 0) return true;

  // 100.64.0.0/10 (Carrier-grade NAT)
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;

  return false;
}

/**
 * Validates a URL against SSRF vulnerabilities.
 * Disallows:
 * - Non-HTTP/HTTPS protocols
 * - Loopback domains (localhost, *.localhost)
 * - Cloud metadata endpoints
 * - Private, link-local, and reserved IP ranges
 */
export function validateWebhookUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);

    // Protocol must be http or https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Loopback names
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "metadata.google.internal" ||
      hostname === "instance-data"
    ) {
      return false;
    }

    // IP address inspection
    const ipType = net.isIP(hostname);
    if (ipType === 4) {
      return !isPrivateIPv4(hostname);
    } else if (ipType === 6) {
      // Reject IPv6 loopback (::1), link-local (fe80::), unique local (fc00::/7)
      const cleanIPv6 = hostname.toLowerCase();
      if (
        cleanIPv6 === "::1" ||
        cleanIPv6.startsWith("fe80:") ||
        cleanIPv6.startsWith("fc00:") ||
        cleanIPv6.startsWith("fd00:")
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
