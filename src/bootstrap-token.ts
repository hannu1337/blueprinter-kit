/**
 * Service bootstrap tokens (ADR-0016).
 *
 * For one run the blueprinter issues a token, stores
 * `sha256(token) -> { scope, tenant?, expiresAt }` in the service stage's
 * operators KV namespace with a native `expiration_ttl`, and deletes the key
 * when the run ends. The service checks a presented token with
 * `verifyBootstrapToken`. Runs on Workers and Node (Web Crypto only).
 */

export type BootstrapScope = "tenants" | "instance";

export interface BootstrapTokenRecord {
  scope: BootstrapScope;
  /** Restricts a `tenants` token to one tenant. */
  tenant?: string;
  /** Epoch seconds. */
  expiresAt: number;
}

/** The subset of a Workers KV namespace binding the verifier needs. */
export interface KvReader {
  get(key: string): Promise<string | null>;
}

export const BOOTSTRAP_TOKEN_PREFIX = "bkt_";
export const BOOTSTRAP_TOKEN_TTL_MIN_SECONDS = 60;
export const BOOTSTRAP_TOKEN_TTL_MAX_SECONDS = 3600;

const TOKEN_PATTERN = /^bkt_[A-Za-z0-9_-]{43}$/;
const SCOPES: readonly BootstrapScope[] = ["tenants", "instance"];

const epochSeconds = () => Math.floor(Date.now() / 1000);

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The KV key of a token: the lowercase hex sha256 of its UTF-8 bytes. */
export async function bootstrapTokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IssueBootstrapTokenOptions {
  scope: BootstrapScope;
  tenant?: string;
  ttlSeconds: number;
  /** Epoch seconds; defaults to now. */
  now?: number;
}

export interface IssuedBootstrapToken {
  /** The secret handed to the setup CLI on stdin. Never stored. */
  token: string;
  /** The KV key to write the record under. */
  key: string;
  record: BootstrapTokenRecord;
  /** The KV `expiration_ttl` to write the record with. */
  expirationTtl: number;
}

/** Generates a 256-bit token and the KV entry that makes it valid. */
export async function issueBootstrapToken(options: IssueBootstrapTokenOptions): Promise<IssuedBootstrapToken> {
  const { scope, tenant, ttlSeconds, now = epochSeconds() } = options;
  if (!SCOPES.includes(scope)) throw new TypeError(`unknown bootstrap token scope: ${String(scope)}`);
  if (tenant !== undefined && (scope !== "tenants" || typeof tenant !== "string" || tenant === "")) {
    throw new TypeError("only a tenants-scoped token can be restricted to a tenant");
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < BOOTSTRAP_TOKEN_TTL_MIN_SECONDS ||
    ttlSeconds > BOOTSTRAP_TOKEN_TTL_MAX_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be an integer from ${BOOTSTRAP_TOKEN_TTL_MIN_SECONDS} to ${BOOTSTRAP_TOKEN_TTL_MAX_SECONDS}`,
    );
  }
  const token = BOOTSTRAP_TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const record: BootstrapTokenRecord =
    tenant === undefined ? { scope, expiresAt: now + ttlSeconds } : { scope, tenant, expiresAt: now + ttlSeconds };
  return { token, key: await bootstrapTokenKey(token), record, expirationTtl: ttlSeconds };
}

export interface VerifyBootstrapTokenExpectation {
  scope: BootstrapScope;
  /** The tenant the request acts on; must match a tenant-restricted token. */
  tenant?: string;
  /** Epoch seconds; defaults to now. */
  now?: number;
}

export type VerifyBootstrapTokenResult =
  | { ok: true; scope: BootstrapScope; tenant?: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "unknown" | "expired" | "scope" | "tenant" | "corrupt" | "unavailable" };

function parseRecord(raw: string): BootstrapTokenRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { scope, tenant, expiresAt } = value as Record<string, unknown>;
  if (typeof scope !== "string" || !SCOPES.includes(scope as BootstrapScope)) return undefined;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
  if (tenant !== undefined && (typeof tenant !== "string" || scope !== "tenants")) return undefined;
  return tenant === undefined
    ? { scope: scope as BootstrapScope, expiresAt }
    : { scope: scope as BootstrapScope, tenant, expiresAt };
}

/**
 * Checks a presented service bootstrap token against the operators KV
 * namespace. Fails closed: a token restricted to a tenant is accepted only
 * when `expected.tenant` names that tenant.
 */
export async function verifyBootstrapToken(
  kv: KvReader,
  token: string | null | undefined,
  expected: VerifyBootstrapTokenExpectation,
): Promise<VerifyBootstrapTokenResult> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return { ok: false, reason: "malformed" };
  let raw: string | null;
  try {
    raw = await kv.get(await bootstrapTokenKey(token));
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (raw === null) return { ok: false, reason: "unknown" };
  const record = parseRecord(raw);
  if (!record) return { ok: false, reason: "corrupt" };
  if (record.expiresAt <= (expected.now ?? epochSeconds())) return { ok: false, reason: "expired" };
  if (record.scope !== expected.scope) return { ok: false, reason: "scope" };
  if (record.tenant !== undefined && record.tenant !== expected.tenant) return { ok: false, reason: "tenant" };
  return record.tenant === undefined
    ? { ok: true, scope: record.scope, expiresAt: record.expiresAt }
    : { ok: true, scope: record.scope, tenant: record.tenant, expiresAt: record.expiresAt };
}
