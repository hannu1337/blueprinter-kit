import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, type Envelope, type Request } from "../src/index.ts";
import { SetupCliError, defineSetupCli, runSetupCli, type CheckDefinition, type SetupCli } from "../src/setup-cli.ts";

const TOKEN = "bkt_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const project = { slug: "shop", stage: "staging", zone: "example.test", hostnames: ["staging.shop.example.test"] } as const;

function request(extra: Partial<Request> = {}): Request {
  return { protocolVersion: PROTOCOL_VERSION, command: "probe", scope: "tenant", project: { ...project, hostnames: [...project.hostnames] }, inputs: {}, credentials: {}, ...extra };
}

interface Calls {
  probe: number;
  plan: number;
  fix: number;
  teardown: number;
  lastRotate?: boolean;
}

function sampleCli(calls: Calls = { probe: 0, plan: 0, fix: 0, teardown: 0 }, extraChecks: CheckDefinition[] = []): SetupCli {
  return defineSetupCli({
    id: "demo",
    inputs: [{ key: "greeting", type: "string", scope: "tenant", title: "Greeting" }],
    checks: [
      {
        id: "demo.reachable",
        scope: "instance",
        title: "Instance reachable",
        access: "public",
        dependsOn: ["cloudflare.worker.api.<stage>"],
        probe: () => {
          calls.probe++;
          return { state: "ok" };
        },
        plan: () => ({ summary: "nothing" }),
        fix: () => ({ outputs: {} }),
      },
      {
        id: "demo.tenant",
        scope: "tenant",
        title: "Tenant exists",
        dependsOn: ["deploy.staging"],
        probe: (ctx) => {
          calls.probe++;
          ctx.log(`probing with ${ctx.credentials.serviceBootstrapToken}`);
          return { state: "missing", detail: `no tenant ${ctx.project.slug}` };
        },
        plan: (ctx) => {
          calls.plan++;
          return { summary: `create tenant ${ctx.project.slug}` };
        },
        fix: (ctx) => {
          calls.fix++;
          calls.lastRotate = ctx.rotate;
          ctx.setCredential("tenantSetupToken", "tst_secretvalue");
          return { outputs: { DEMO_SECRET: "s3cr3t", DEMO_URL: "https://demo.invalid" } };
        },
      },
      {
        id: "demo.webhook",
        scope: "tenant",
        title: "Webhook registered by hand",
        humanOnly: true,
        dependsOn: ["demo.tenant"],
        probe: () => ({ state: "missing", waitingFor: "a human to register the webhook" }),
      },
      ...extraChecks,
    ],
    teardown: (ctx) => {
      calls.teardown++;
      return ctx.credentials.tenantSetupToken ? ["tenantSetupToken"] : [];
    },
  });
}

async function call(cli: SetupCli, argv: string[], stdin: string | Request = "") {
  let stderr = "";
  const out = await runSetupCli(cli, {
    argv,
    stdin: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  assert.ok(out.stdout.endsWith("\n"), "stdout ends with a newline");
  assert.equal(out.stdout.trimEnd().split("\n").length, 1, "stdout is one line");
  const envelope = JSON.parse(out.stdout) as Envelope<any>;
  assert.equal(out.exitCode, envelope.ok ? 0 : 1, "exit code follows the envelope");
  return { envelope, stderr, exitCode: out.exitCode };
}

function errorCode(envelope: Envelope<unknown>) {
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  return envelope.ok ? undefined : envelope.error.code;
}

describe("defineSetupCli", () => {
  const base = { scope: "tenant" as const, title: "t", probe: () => ({ state: "ok" as const }) };
  const cases: Array<[string, CheckDefinition[]]> = [
    ["a check id outside the namespace", [{ ...base, id: "other.tenant" }]],
    ["a malformed check id", [{ ...base, id: "demo.Tenant" }]],
    ["a duplicate check id", [{ ...base, id: "demo.a" }, { ...base, id: "demo.a" }]],
    ["a dependency that is neither core nor own", [{ ...base, id: "demo.a", dependsOn: ["cloudflare.token.staging"] }]],
    ["a dependency on another scope", [{ ...base, id: "demo.a", dependsOn: ["demo.b"] }, { ...base, id: "demo.b", scope: "instance" }]],
    ["a dependency cycle", [{ ...base, id: "demo.a", dependsOn: ["demo.b"] }, { ...base, id: "demo.b", dependsOn: ["demo.a"] }]],
    ["a human-only check with a fix", [{ ...base, id: "demo.a", humanOnly: true, plan: () => ({ summary: "x" }), fix: () => ({ outputs: {} }) }]],
    ["a fix without a plan", [{ ...base, id: "demo.a", fix: () => ({ outputs: {} }) }]],
    ["a plan without a fix", [{ ...base, id: "demo.a", plan: () => ({ summary: "x" }) }]],
    ["a check that is neither fixable nor human-only", [{ ...base, id: "demo.a" }]],
  ];
  for (const [name, checks] of cases) {
    it(`rejects ${name}`, () => {
      assert.throws(() => defineSetupCli({ id: "demo", checks }), TypeError);
    });
  }

  it("rejects a malformed service id", () => {
    assert.throws(() => defineSetupCli({ id: "Demo", checks: [] }), TypeError);
  });
});

describe("runSetupCli", () => {
  it("describes inputs and checks with protocol defaults, without reading stdin", async () => {
    const { envelope } = await call(sampleCli(), ["describe"], "this is not read");
    assert.deepEqual(envelope, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        id: "demo",
        inputs: [{ key: "greeting", type: "string", scope: "tenant", title: "Greeting", perStage: true, required: true }],
        checks: [
          { id: "demo.reachable", scope: "instance", title: "Instance reachable", dependsOn: ["cloudflare.worker.api.<stage>"], access: "public", humanOnly: false },
          { id: "demo.tenant", scope: "tenant", title: "Tenant exists", dependsOn: ["deploy.staging"], access: "service-token", humanOnly: false },
          { id: "demo.webhook", scope: "tenant", title: "Webhook registered by hand", dependsOn: ["demo.tenant"], access: "service-token", humanOnly: true },
        ],
      },
    });
  });

  it("answers an unknown command with an error envelope", async () => {
    const { envelope, exitCode } = await call(sampleCli(), ["frobnicate"]);
    assert.equal(errorCode(envelope), "unknown-command");
    assert.equal(exitCode, 1);
    assert.equal(errorCode((await call(sampleCli(), [])).envelope), "unknown-command");
  });

  it("rejects unknown flags and stray arguments", async () => {
    assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant", "--force"], request())).envelope), "bad-request");
    assert.equal(errorCode((await call(sampleCli(), ["describe", "extra"])).envelope), "bad-request");
    assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant", "--rotate"], request())).envelope), "bad-request");
  });

  it("rejects stdin that is not one JSON object", async () => {
    for (const stdin of ["", "{", "[]", "1", '{"a":1} {"b":2}']) {
      assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant"], stdin)).envelope), "bad-request", stdin);
    }
  });

  it("refuses another protocol version", async () => {
    const r = request({ protocolVersion: 999 as never });
    assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant"], r)).envelope), "unsupported-protocol");
  });

  it("requires argv and stdin to agree", async () => {
    assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant"], request({ command: "fix" }))).envelope), "bad-request");
    assert.equal(errorCode((await call(sampleCli(), ["probe", "demo.tenant"], request({ checkId: "demo.webhook" }))).envelope), "bad-request");
  });

  it("takes the check id from stdin when argv has none", async () => {
    const { envelope } = await call(sampleCli(), ["probe"], request({ checkId: "demo.tenant", credentials: { serviceBootstrapToken: TOKEN } }));
    assert.equal(envelope.ok, true);
  });

  it("validates the request of probe, plan and fix", async () => {
    const cli = sampleCli();
    assert.equal(errorCode((await call(cli, ["probe"], request())).envelope), "bad-request");
    assert.equal(errorCode((await call(cli, ["probe", "demo.nope"], request())).envelope), "unknown-check");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ scope: undefined as never }))).envelope), "bad-request");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ scope: "instance" }))).envelope), "scope-mismatch");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ project: undefined as never }))).envelope), "bad-request");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ project: { ...project, stage: "dev" as never, hostnames: [] } }))).envelope), "bad-request");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ credentials: { serviceBootstrapToken: 5 as never } }))).envelope), "bad-request");
    assert.equal(errorCode((await call(cli, ["probe", "demo.tenant"], request({ inputs: { a: 5 as never } }))).envelope), "bad-request");
  });

  it("reports no-access for a token probe without the token, without calling it", async () => {
    const calls = { probe: 0, plan: 0, fix: 0, teardown: 0 };
    const { envelope } = await call(sampleCli(calls), ["probe", "demo.tenant"], request());
    assert.deepEqual(envelope, { ok: true, result: { state: "no-access", detail: "needs the service bootstrap token" } });
    assert.equal(calls.probe, 0);
  });

  it("runs a public probe without credentials", async () => {
    const calls = { probe: 0, plan: 0, fix: 0, teardown: 0 };
    const { envelope } = await call(sampleCli(calls), ["probe", "demo.reachable"], request({ scope: "instance" }));
    assert.deepEqual(envelope, { ok: true, result: { state: "ok" } });
    assert.equal(calls.probe, 1);
  });

  it("answers plan and fix of a human-only check with not-fixable", async () => {
    for (const command of ["plan", "fix"] as const) {
      const { envelope } = await call(sampleCli(), [command, "demo.webhook"], request({ command, credentials: { serviceBootstrapToken: TOKEN } }));
      assert.equal(errorCode(envelope), "not-fixable");
    }
  });

  it("refuses plan and fix without the token, before calling them", async () => {
    const calls = { probe: 0, plan: 0, fix: 0, teardown: 0 };
    for (const command of ["plan", "fix"] as const) {
      for (const id of ["demo.tenant", "demo.reachable"]) {
        const scope = id === "demo.reachable" ? "instance" : "tenant";
        const { envelope } = await call(sampleCli(calls), [command, id], request({ command, scope }));
        assert.equal(errorCode(envelope), "no-credential");
      }
    }
    assert.deepEqual(calls, { probe: 0, plan: 0, fix: 0, teardown: 0 });
  });

  it("plans and fixes, passing --rotate and returning minted credentials", async () => {
    const calls: Calls = { probe: 0, plan: 0, fix: 0, teardown: 0 };
    const cli = sampleCli(calls);
    const creds = { serviceBootstrapToken: TOKEN };
    const plan = await call(cli, ["plan", "demo.tenant"], request({ command: "plan", credentials: creds }));
    assert.deepEqual(plan.envelope, { ok: true, result: { summary: "create tenant shop" } });

    const fix = await call(cli, ["fix", "demo.tenant", "--rotate"], request({ command: "fix", credentials: creds }));
    assert.deepEqual(fix.envelope, {
      ok: true,
      result: { outputs: { DEMO_SECRET: "s3cr3t", DEMO_URL: "https://demo.invalid" } },
      credentials: { tenantSetupToken: "tst_secretvalue" },
    });
    assert.equal(calls.lastRotate, true);

    await call(cli, ["fix", "demo.tenant"], request({ command: "fix", rotate: true, credentials: creds }));
    assert.equal(calls.lastRotate, true);
    await call(cli, ["fix", "demo.tenant"], request({ command: "fix", credentials: creds }));
    assert.equal(calls.lastRotate, false);
  });

  it("maps a thrown SetupCliError to its envelope and anything else to internal", async () => {
    const failing = (thrown: unknown) =>
      defineSetupCli({
        id: "demo",
        checks: [{ id: "demo.a", scope: "tenant", title: "a", humanOnly: true, access: "public", probe: () => { throw thrown; } }],
      });
    const service = await call(failing(new SetupCliError("service-error", "service said 503", "try later")), ["probe", "demo.a"], request());
    assert.deepEqual(service.envelope, { ok: false, error: { code: "service-error", message: "service said 503", hint: "try later" } });
    const internal = await call(failing(new Error("boom")), ["probe", "demo.a"], request());
    assert.deepEqual(internal.envelope, { ok: false, error: { code: "internal", message: "boom" } });
    assert.match(internal.stderr, /boom/);
    const weird = await call(failing("a string"), ["probe", "demo.a"], request());
    assert.equal(errorCode(weird.envelope), "internal");
  });

  it("rejects a malformed handler result as internal", async () => {
    const cli = (probe: () => unknown, fix: () => unknown = () => ({ outputs: {} })) =>
      defineSetupCli({
        id: "demo",
        checks: [{ id: "demo.a", scope: "tenant", title: "a", access: "public", probe: probe as never, plan: () => ({ summary: "x" }), fix: fix as never }],
      });
    assert.equal(errorCode((await call(cli(() => ({ state: "fine" })), ["probe", "demo.a"], request())).envelope), "internal");
    assert.equal(errorCode((await call(cli(() => undefined), ["probe", "demo.a"], request())).envelope), "internal");
    const creds = { serviceBootstrapToken: TOKEN };
    assert.equal(errorCode((await call(cli(() => ({ state: "ok" }), () => ({ outputs: "x" })), ["fix", "demo.a"], request({ command: "fix", credentials: creds }))).envelope), "internal");
    assert.equal(errorCode((await call(cli(() => ({ state: "ok" }), () => ({ outputs: { A: undefined } })), ["fix", "demo.a"], request({ command: "fix", credentials: creds }))).envelope), "internal");
  });

  it("redacts credentials and secret inputs from logs and error messages", async () => {
    const leaky = defineSetupCli({
      id: "demo",
      inputs: [{ key: "apiKey", type: "secret", scope: "tenant", title: "API key" }],
      checks: [
        {
          id: "demo.a",
          scope: "tenant",
          title: "a",
          humanOnly: true,
          probe: (ctx) => {
            ctx.log(`token ${ctx.credentials.serviceBootstrapToken} key ${String(ctx.inputs.apiKey)}`);
            throw new Error(`failed with ${ctx.credentials.serviceBootstrapToken} and ${String(ctx.inputs.apiKey)}`);
          },
        },
      ],
    });
    const { envelope, stderr } = await call(leaky, ["probe", "demo.a"], request({ inputs: { apiKey: "sk_live_value" }, credentials: { serviceBootstrapToken: TOKEN } }));
    const text = JSON.stringify(envelope) + stderr;
    assert.ok(!text.includes(TOKEN), "token redacted");
    assert.ok(!text.includes("sk_live_value"), "secret input redacted");
    assert.match(stderr, /token \*\*\* key \*\*\*/);
  });

  it("tears down with whatever credentials it gets, even none", async () => {
    const calls: Calls = { probe: 0, plan: 0, fix: 0, teardown: 0 };
    const cli = sampleCli(calls);
    const empty = await call(cli, ["teardown"], "");
    assert.deepEqual(empty.envelope, { ok: true, result: { revoked: [] } });
    const full = await call(cli, ["teardown"], request({ command: "teardown", credentials: { serviceBootstrapToken: TOKEN, tenantSetupToken: "tst_x" } }));
    assert.deepEqual(full.envelope, { ok: true, result: { revoked: ["tenantSetupToken"] } });
    assert.equal(calls.teardown, 2);
    const none = defineSetupCli({ id: "demo", checks: [] });
    assert.deepEqual((await call(none, ["teardown"], "")).envelope, { ok: true, result: { revoked: [] } });
  });
});

describe("serve", () => {
  const noisy = fileURLToPath(new URL("./fixtures/noisy-setup-cli.ts", import.meta.url));

  it("keeps stdout to one JSON envelope while handlers print to stdout", () => {
    const run = spawnSync(process.execPath, [noisy, "probe", "noisy.a"], {
      input: JSON.stringify(request()),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, result: { state: "ok", detail: "quiet" } });
    assert.equal(run.stdout.trimEnd().split("\n").length, 1);
    assert.match(run.stderr, /console\.log line/);
    assert.match(run.stderr, /stdout\.write line/);
    assert.match(run.stderr, /console\.info line/);
  });

  it("answers describe with closed stdin and exits non-zero on an error envelope", () => {
    const describeRun = spawnSync(process.execPath, [noisy, "describe"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    assert.equal(describeRun.status, 0, describeRun.stderr);
    assert.equal(JSON.parse(describeRun.stdout).result.id, "noisy");
    const bad = spawnSync(process.execPath, [noisy, "nope"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).error.code, "unknown-command");
  });
});
