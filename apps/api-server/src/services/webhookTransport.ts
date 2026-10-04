import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, type TLSSocket } from "node:tls";
import ipaddr from "ipaddr.js";
import {
  isPublicWebhookAddress,
  parseWebhookDestination,
  WebhookDeliveryError,
} from "./webhookDestination.js";

export const WEBHOOK_TIMEOUT_MS = 8_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const WEBHOOK_MAX_REQUEST_BYTES = 16 * 1024;
export const WEBHOOK_MAX_CONCURRENT = 4;
export const WEBHOOK_MAX_QUEUED = 64;
const MAX_DNS_ADDRESSES = 32;
let active = 0;
const waiting: Array<{ grant: () => void; signal: AbortSignal }> = [];

async function acquire(signal: AbortSignal): Promise<void> {
  if (active < WEBHOOK_MAX_CONCURRENT) {
    active++;
    return;
  }
  if (waiting.length >= WEBHOOK_MAX_QUEUED) {
    throw new WebhookDeliveryError("Webhook delivery is busy; try again later");
  }
  await new Promise<void>((resolve, reject) => {
    const entry = { signal, grant: () => { signal.removeEventListener("abort", abort); resolve(); } };
    const abort = () => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new WebhookDeliveryError("Webhook delivery timed out; try again later"));
    };
    waiting.push(entry);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function release(): void {
  active--;
  const entry = waiting.shift();
  if (entry) {
    active++;
    entry.grant();
  }
}

async function resolveDestination(hostname: string, resolver: Resolver): Promise<string> {
  if (isIP(hostname)) return hostname; // Literal IP was checked by URL policy.
  const results = await Promise.allSettled([
    resolver.resolve4(hostname), resolver.resolve6(hostname),
  ]);
  const addresses: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") addresses.push(...result.value);
    else if (!["ENODATA", "ENOTFOUND"].includes((result.reason as NodeJS.ErrnoException)?.code ?? "")) {
      throw new WebhookDeliveryError("Webhook destination DNS lookup failed; try again later");
    }
  }
  if (!addresses.length || addresses.length > MAX_DNS_ADDRESSES ||
      addresses.some((address) => !isPublicWebhookAddress(address))) {
    throw new WebhookDeliveryError("Webhook destination must resolve only to public Internet addresses");
  }
  return addresses[0];
}

function postPinned(url: URL, address: string, body: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WebhookDeliveryError("Webhook delivery timed out; try again later"));
      return;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    // Connect to the validated NUMERIC IP, never perform a second name lookup.
    // A fresh agent prevents pooled sockets/proxies/TLS sessions bypassing this
    // decision. Keep HTTP Host and TLS certificate verification on the URL host.
    const req = request({
      hostname: address,
      family: isIP(address),
      port: 443,
      path: url.pathname + url.search,
      method: "POST",
      agent: false,
      servername: isIP(hostname) ? "" : hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
      signal,
      maxHeaderSize: 16 * 1024,
      headers: {
        Host: url.host,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.on("error", reject);
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new WebhookDeliveryError(status >= 300 && status < 400
          ? "Webhook destination redirects are not supported; use its final HTTPS URL"
          : "Webhook destination rejected the delivery"));
        return;
      }
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > WEBHOOK_MAX_RESPONSE_BYTES) {
          response.destroy();
          req.destroy();
          reject(new WebhookDeliveryError("Webhook response exceeded the size limit"));
        }
      });
      response.once("end", resolve);
      response.once("aborted", () => reject(new WebhookDeliveryError("Webhook response was interrupted")));
    });
    req.once("error", reject);
    req.once("socket", (socket) => {
      (socket as TLSSocket).once("secureConnect", () => {
        if (!socket.remoteAddress || !isIP(socket.remoteAddress) ||
            ipaddr.process(socket.remoteAddress).toNormalizedString() !==
            ipaddr.process(address).toNormalizedString()) {
          req.destroy();
          reject(new WebhookDeliveryError("Webhook connection did not match the approved address"));
          return;
        }
        // Do not send headers/payload before TLS validation and the peer check.
        req.end(body);
      });
    });
  });
}

export async function postWebhookJson(destination: string, payload: unknown): Promise<void> {
  let acquired = false;
  let resolver: Resolver | undefined;
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => resolver?.cancel();
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    const url = parseWebhookDestination(destination);
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > WEBHOOK_MAX_REQUEST_BYTES) {
      throw new WebhookDeliveryError("Webhook payload exceeded the size limit");
    }
    await Promise.race([
      (async () => {
        await acquire(controller.signal);
        acquired = true;
        if (controller.signal.aborted) throw new WebhookDeliveryError("Webhook delivery timed out; try again later");
        resolver = new Resolver({ timeout: 2_000, tries: 1 });
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const address = await resolveDestination(hostname, resolver);
        await postPinned(url, address, body, controller.signal);
      })(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new WebhookDeliveryError("Webhook delivery timed out; try again later"));
          controller.abort(); // Cancel both DNS queries and any active request.
        }, WEBHOOK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Do not propagate upstream exception text, URL credentials, or bot tokens.
    throw error instanceof WebhookDeliveryError ? error :
      new WebhookDeliveryError("Webhook delivery failed; check the destination and try again");
  } finally {
    if (deadline) clearTimeout(deadline);
    controller.signal.removeEventListener("abort", cancel);
    resolver?.cancel();
    if (acquired) release();
  }
}
