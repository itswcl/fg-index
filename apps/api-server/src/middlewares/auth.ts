import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";

// ─── Augment Express Request ──────────────────────────────────────
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

// ─── JWKS (exported for test overriding) ──────────────────────────
// Lazy singleton — constructed on first use so tests can override `getJWKS`
// before the real one is materialized. `createRemoteJWKSet` caches keys
// internally and refreshes on rotation.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function getJWKS() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));
  }
  return jwks;
}

// Allow tests to inject a verifier that doesn't hit the network.
type VerifyFn = (token: string) => Promise<JWTPayload>;

let verifyOverride: VerifyFn | null = null;

export function __setVerifyOverrideForTests(fn: VerifyFn | null): void {
  verifyOverride = fn;
}

export async function verifySupabaseJwt(token: string): Promise<JWTPayload> {
  if (verifyOverride) return verifyOverride(token);

  const { payload } = await jwtVerify(token, getJWKS(), {
    issuer: env.SUPABASE_URL,
    audience: "authenticated",
  });
  return payload;
}

// ─── User upsert ──────────────────────────────────────────────────
// On first authenticated request, create the User row so FKs in Alert /
// WebhookConfig are satisfied. Keyed by Supabase `sub` (UUID).
async function upsertUser(userId: string, email: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    update: { email },
    create: { id: userId, email },
  });
}

// ─── Middleware ───────────────────────────────────────────────────
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      throw new HttpError(
        401,
        "Missing or malformed Authorization header",
        "UNAUTHORIZED"
      );
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      throw new HttpError(401, "Empty bearer token", "UNAUTHORIZED");
    }

    let payload: JWTPayload;
    try {
      payload = await verifySupabaseJwt(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid token";
      throw new HttpError(401, `Invalid token: ${msg}`, "INVALID_TOKEN");
    }

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const email =
      typeof (payload as { email?: unknown }).email === "string"
        ? (payload as { email: string }).email
        : null;

    if (!sub || !email) {
      throw new HttpError(
        401,
        "Token missing required claims (sub, email)",
        "INVALID_TOKEN"
      );
    }

    await upsertUser(sub, email);

    req.userId = sub;
    req.userEmail = email;
    next();
  } catch (error) {
    handleError(res, error);
  }
}
