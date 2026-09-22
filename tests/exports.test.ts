import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as kit from "../src/index.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

function importsOf(path: string, seen = new Set<string>()): Set<string> {
  if (seen.has(path)) return seen;
  seen.add(path);
  for (const [, spec] of read(path).matchAll(/from\s+"([^"]+)"/g)) {
    if (spec?.startsWith("./")) importsOf(spec.slice(2), seen);
    else if (spec) seen.add(spec);
  }
  return seen;
}

describe("the root entry", () => {
  it("imports nothing but its own Web-standard modules, so a Worker can use it", () => {
    const deps = [...importsOf("index.ts")].filter((d) => !d.endsWith(".ts"));
    assert.deepEqual(deps, []);
  });

  it("exports the protocol and the bootstrap-token functions", () => {
    for (const name of ["PROTOCOL_VERSION", "COMMANDS", "SCOPES", "STABLE_CORE_CHECK_IDS", "isStableCoreCheckId", "resolveDependency", "verifyBootstrapToken", "issueBootstrapToken", "bootstrapTokenKey"]) {
      assert.ok(name in kit, name);
    }
    assert.equal(kit.PROTOCOL_VERSION, 1);
    assert.equal(kit.resolveDependency("cloudflare.zone.<stage>", "production"), "cloudflare.zone.production");
    assert.equal(kit.isStableCoreCheckId("cloudflare.worker.web.staging"), true);
    assert.equal(kit.isStableCoreCheckId("cloudflare.token.staging"), false);
    assert.equal(kit.parseDurationSeconds("PT1H"), 3600);
    assert.equal(kit.parseDurationSeconds("PT"), undefined);
  });
});

describe("package.json", () => {
  it("builds dist on install and ships only dist and the schema", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.scripts.prepare, "node scripts/prepare.mjs");
    assert.deepEqual(pkg.files, ["dist", "schema"]);
    assert.equal(pkg.bin["blueprinter-kit"], "dist/cli.js");
  });
});
