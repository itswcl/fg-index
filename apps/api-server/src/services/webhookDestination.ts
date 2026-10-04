import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class WebhookDeliveryError extends Error {}

export function webhookDeliveryErrorMessage(error: unknown): string {
  return error instanceof WebhookDeliveryError
    ? error.message
    : "Webhook delivery failed; check the destination and try again";
}

// ipaddr.js 2.2.0 covers the IPv4 special registry and most IPv6 entries.
// Reviewed against both IANA special-purpose registries (2025-10-09 revision):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Conservatively reject ALL special-purpose ranges, even global anycast entries.
// IPv6 is limited to allocated global unicast 2000::/3; 3fff::/20 is the
// newer documentation range missing from ipaddr.js 2.2.0. Review on upgrades.
const globalV6 = ipaddr.parseCIDR("2000::/3");
const documentationV6 = ipaddr.parseCIDR("3fff::/20");

export function isPublicWebhookAddress(address: string): boolean {
  if (!isIP(address) || address.includes("%")) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast") return false;
  return parsed.kind() === "ipv4" ||
    (parsed.match(globalV6) && !parsed.match(documentationV6));
}

export function parseWebhookDestination(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDeliveryError("Webhook destination must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") ||
      url.username || url.password || url.hash) {
    throw new WebhookDeliveryError(
      "Webhook destination must use HTTPS on port 443 without credentials or a fragment",
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicWebhookAddress(hostname)) {
    throw new WebhookDeliveryError("Webhook destination must use a public Internet address");
  }
  return url;
}
