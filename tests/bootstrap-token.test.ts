import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  BOOTSTRAP_TOKEN_TTL_MAX_SECONDS,
  bootstrapTokenKey,
  issueBootstrapToken,
  verifyBootstrapToken,
  type BootstrapTokenRecord,
  type KvReader,
} from "../src/index.ts";

const NOW = 1_800_000_000;

function memoryKv(entries: Record<string, string> = {}): KvReader & { entries: Record<string, string> } {
  return {
    entries,
    async get(key: string) {
      return Object.hasOwn(entries, key) ? (entries[key] ?? null) : null;
    },
  };
}

async function stored(record: BootstrapTokenRecord | string, token?: string) {
  const issued = await issueBootstrapToken({ scope: "tenants", ttlSeconds: 3600, now: NOW });
  const t = token ?? issued.token;
  const kv = memoryKv({
    [await bootstrapTokenKey(t)]: typeof record === "string" ? record : JSON.stringify(record),
  });
  return { kv, token: t };
}

describe("issueBootstrapToken", () => {
  it("returns a 256-bit token, its sha256 key, the record and a native TTL", async () => {
    const issued = await issueBootstrapToken({ scope: "instance", ttlSeconds: 900, now: NOW });
    assert.match(issued.token, /^bkt_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.key, createHash("sha256").update(issued.token).digest("hex"));
    assert.deepEqual(issued.record, { scope: "instance", expiresAt: NOW + 900 });
    assert.equal(issued.expirationTtl, 900);
  });

  it("records the tenant for a tenants-scoped token", async () => {
    const issued = await issueBootstrapToken({ scope: "tenants", tenant: "shop", ttlSeconds: 600, now: NOW });
    assert.deepEqual(issued.record, { scope: "tenants", tenant: "shop", expiresAt: NOW + 600 });
  });

  it("never issues the same token twice", async () => {
    const a = await issueBootstrapToken({ scope: "instance", ttlSeconds: 60 });
    const b = await issueBootstrapToken({ scope: "instance", ttlSeconds: 60 });
    assert.notEqual(a.token, b.token);
  });

  it("refuses a TTL outside 60 seconds to one hour", async () => {
    await assert.rejects(issueBootstrapToken({ scope: "instance", ttlSeconds: 59 }), RangeError);
    await assert.rejects(
      issueBootstrapToken({ scope: "instance", ttlSeconds: BOOTSTRAP_TOKEN_TTL_MAX_SECONDS + 1 }),
      RangeError,
    );
    await assert.rejects(issueBootstrapToken({ scope: "instance", ttlSeconds: 1.5 }), RangeError);
  });

  it("refuses a tenant on an instance-scoped token and an unknown scope", async () => {
    await assert.rejects(issueBootstrapToken({ scope: "instance", tenant: "x", ttlSeconds: 60 }), TypeError);
    // @ts-expect-error scope "both" does not exist
    await assert.rejects(issueBootstrapToken({ scope: "both", ttlSeconds: 60 }), TypeError);
  });
});

describe("verifyBootstrapToken", () => {
  it("accepts an issued token for its scope before it expires", async () => {
    const issued = await issueBootstrapToken({ scope: "tenants", ttlSeconds: 3600, now: NOW });
    const kv = memoryKv({ [issued.key]: JSON.stringify(issued.record) });
    const result = await verifyBootstrapToken(kv, issued.token, { scope: "tenants", now: NOW + 10 });
    assert.deepEqual(result, { ok: true, scope: "tenants", expiresAt: NOW + 3600 });
  });

  it("rejects a missing or malformed token without reading KV", async () => {
    let reads = 0;
    const kv: KvReader = {
      async get() {
        reads++;
        return null;
      },
    };
    for (const token of [undefined, null, "", "bkt_short", "Bearer bkt_x", "x".repeat(47), `bkt_${"a".repeat(42)}!`]) {
      const result = await verifyBootstrapToken(kv, token, { scope: "tenants", now: NOW });
      assert.deepEqual(result, { ok: false, reason: "malformed" }, String(token));
    }
    assert.equal(reads, 0);
  });

  it("rejects a well-formed token that is not stored", async () => {
    const issued = await issueBootstrapToken({ scope: "tenants", ttlSeconds: 60, now: NOW });
    const result = await verifyBootstrapToken(memoryKv(), issued.token, { scope: "tenants", now: NOW });
    assert.deepEqual(result, { ok: false, reason: "unknown" });
  });

  it("rejects an expired token even while KV still holds it", async () => {
    const { kv, token } = await stored({ scope: "tenants", expiresAt: NOW });
    assert.deepEqual(await verifyBootstrapToken(kv, token, { scope: "tenants", now: NOW }), {
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token of the other scope", async () => {
    const { kv, token } = await stored({ scope: "instance", expiresAt: NOW + 60 });
    assert.deepEqual(await verifyBootstrapToken(kv, token, { scope: "tenants", now: NOW }), {
      ok: false,
      reason: "scope",
    });
  });

  it("binds a tenant-restricted token to that tenant and fails closed", async () => {
    const { kv, token } = await stored({ scope: "tenants", tenant: "shop", expiresAt: NOW + 60 });
    assert.deepEqual(await verifyBootstrapToken(kv, token, { scope: "tenants", tenant: "shop", now: NOW }), {
      ok: true,
      scope: "tenants",
      tenant: "shop",
      expiresAt: NOW + 60,
    });
    for (const tenant of ["other", undefined]) {
      assert.deepEqual(
        await verifyBootstrapToken(kv, token, tenant === undefined ? { scope: "tenants", now: NOW } : { scope: "tenants", tenant, now: NOW }),
        { ok: false, reason: "tenant" },
      );
    }
  });

  it("rejects a corrupt record instead of trusting it", async () => {
    for (const record of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ scope: "tenants" }),
      JSON.stringify({ scope: "tenants", expiresAt: "soon" }),
      JSON.stringify({ scope: ["tenants", "instance"], expiresAt: NOW + 60 }),
      JSON.stringify({ scope: "instance", tenant: "shop", expiresAt: NOW + 60 }),
      JSON.stringify({ scope: "tenants", tenant: 7, expiresAt: NOW + 60 }),
    ]) {
      const { kv, token } = await stored(record);
      assert.deepEqual(await verifyBootstrapToken(kv, token, { scope: "tenants", now: NOW }), {
        ok: false,
        reason: "corrupt",
      }, record);
    }
  });

  it("uses the current time when none is given", async () => {
    const issued = await issueBootstrapToken({ scope: "instance", ttlSeconds: 60 });
    const kv = memoryKv({ [issued.key]: JSON.stringify(issued.record) });
    assert.equal((await verifyBootstrapToken(kv, issued.token, { scope: "instance" })).ok, true);
  });

  it("rejects when KV lookup throws, without leaking the token", async () => {
    const issued = await issueBootstrapToken({ scope: "instance", ttlSeconds: 60 });
    const kv: KvReader = {
      async get() {
        throw new Error("kv down");
      },
    };
    assert.deepEqual(await verifyBootstrapToken(kv, issued.token, { scope: "instance" }), {
      ok: false,
      reason: "unavailable",
    });
  });
});
