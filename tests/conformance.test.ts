import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CONFORMANCE_CHECKS, runConformance, type ConformanceCheckId } from "../src/conformance.ts";
import { checkOverlayPaths } from "../src/overlay.ts";

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));

function failed(report: Awaited<ReturnType<typeof runConformance>>) {
  return report.checks.filter((c) => !c.ok).map((c) => c.id);
}

describe("runConformance", () => {
  it("passes the kit-based sample setup CLI", async () => {
    const report = await runConformance({ dir: fixture("sample") });
    assert.deepEqual(failed(report), [], JSON.stringify(report, null, 2));
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((c) => c.id), CONFORMANCE_CHECKS.map((c) => c.id));
  });

  it("passes a setup CLI written without the kit", async () => {
    const report = await runConformance({ dir: fixture("violations/raw-conformant") });
    assert.deepEqual(failed(report), [], JSON.stringify(report, null, 2));
  });

  const violations: Array<[string, ConformanceCheckId, RegExp]> = [
    ["bad-recipe", "recipe", /obtain/],
    ["describe-hangs", "describe", /timed out after 2s/],
    ["describe-needs-stdin", "describe", /exited with 1/],
    ["stdout-noise", "describe", /not one JSON document/],
    ["bad-check-id", "check-ids", /other\.tenant/],
    ["bad-depends-on", "depends-on", /cloudflare\.token\.staging/],
    ["human-only-fixable", "human-only", /raw\.tenant\.manual/],
    ["fix-missing", "human-only", /raw\.tenant\b/],
    ["probe-ignores-token", "no-access", /raw\.tenant/],
    ["no-error-envelope", "error-envelope", /unknown command/],
    ["teardown-fails", "teardown", /cannot revoke/],
    ["overlay-outside", "overlay", /\.github\/workflows\/deploy\.yml/],
    ["overlay-no-doc", "overlay", /docs\/integrations\/raw\.md/],
  ];
  for (const [name, check, message] of violations) {
    it(`fails ${name} on ${check} only`, async () => {
      const report = await runConformance({ dir: fixture(`violations/${name}`) });
      assert.equal(report.ok, false);
      const bad = report.checks.filter((c) => !c.ok);
      const own = bad.find((c) => c.id === check);
      assert.ok(own, `${check} should fail: ${JSON.stringify(report, null, 2)}`);
      assert.match(own.problems.join("\n"), message);
      // checks that could not run because of it are skipped, never reported as passed
      for (const other of bad.filter((c) => c.id !== check)) assert.equal(other.skipped, true, `${other.id} failed too: ${other.problems.join("; ")}`);
    });
  }

  it("uses an entry given on the command line instead of the recipe's", async () => {
    const report = await runConformance({ dir: fixture("violations/bad-recipe"), entry: "node setup-cli.mjs" });
    assert.equal(report.entry, "node setup-cli.mjs");
    assert.deepEqual(report.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.id), ["recipe"]);
    assert.deepEqual(report.checks.filter((c) => c.skipped).map((c) => c.id), ["overlay"]);
  });

  it("reports a missing recipe and still checks an entry given on the command line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-"));
    try {
      cpSync(fixture("violations/raw-setup-cli.mjs"), join(dir, "raw-setup-cli.mjs"));
      cpSync(fixture("violations/raw-conformant/setup-cli.mjs"), join(dir, "svc/setup-cli.mjs"));
      const report = await runConformance({ dir: join(dir, "svc"), entry: "node setup-cli.mjs" });
      const recipe = report.checks.find((c) => c.id === "recipe");
      assert.match(recipe?.problems.join() ?? "", /\.integration\/recipe\.json/);
      assert.equal(report.checks.find((c) => c.id === "describe")?.ok, true);
      assert.equal(report.checks.find((c) => c.id === "overlay")?.skipped, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink in the overlay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-"));
    try {
      cpSync(fixture("violations/raw-conformant"), join(dir, "svc"), { recursive: true });
      cpSync(fixture("violations/raw-setup-cli.mjs"), join(dir, "raw-setup-cli.mjs"));
      symlinkSync("/etc/hosts", join(dir, "svc/.integration/overlay/docs/integrations/link.md"));
      const report = await runConformance({ dir: join(dir, "svc") });
      assert.deepEqual(failed(report), ["overlay"]);
      assert.match(report.checks.find((c) => c.id === "overlay")?.problems.join() ?? "", /symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkOverlayPaths", () => {
  it("allows exactly the integration's own files", () => {
    assert.deepEqual(
      checkOverlayPaths("demo", [
        "docs/integrations/demo.md",
        "infra/terraform/integration-demo.tf",
        "app/api/src/integrations/demo/index.ts",
        "app/api/src/integrations/demo/deep/adapter.ts",
        "app/web/layers/integration-demo/nuxt.config.ts",
        "app/api/.dev.vars.example",
        "app/web/.dev.vars.example",
      ]),
      [],
    );
  });

  it("rejects everything else, including another integration's files", () => {
    const bad = [
      "docs/integrations/other.md",
      "docs/features/demo.md",
      "infra/terraform/main.tf",
      "infra/terraform/service-demo.tf",
      "app/api/src/features.ts",
      "app/api/src/integrations/demoer/index.ts",
      "app/api/wrangler.jsonc",
      "app/web/nuxt.config.ts",
      ".github/workflows/deploy.yml",
      "blueprinter.json",
      "package.json",
    ];
    assert.deepEqual(checkOverlayPaths("demo", [...bad, "docs/integrations/demo.md"]).map((p) => p.path), bad);
  });

  it("requires the integration doc", () => {
    assert.deepEqual(checkOverlayPaths("demo", ["infra/terraform/integration-demo.tf"]).map((p) => p.path), ["docs/integrations/demo.md"]);
  });
});

describe("blueprinter-kit conformance", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  it("exits 0 on the sample and prints a line per check", () => {
    const run = spawnSync(process.execPath, [cli, "conformance", fixture("sample")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const check of CONFORMANCE_CHECKS) assert.match(run.stdout, new RegExp(`ok\\s+${check.id}`));
  });

  it("exits 1 on a violation and prints JSON with --json", () => {
    const run = spawnSync(process.execPath, [cli, "conformance", fixture("violations/teardown-fails"), "--json"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, false);
  });

  it("exits 2 on bad usage", () => {
    for (const args of [["frobnicate"], ["conformance", "--timeout", "x"], ["conformance", "--nope"]]) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      assert.equal(run.status, 2, args.join(" "));
    }
  });
});
