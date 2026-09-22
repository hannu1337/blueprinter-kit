// A sample setup CLI built on the kit. It passes conformance and talks to no service:
// "the service" is an in-memory stand-in so the protocol can be exercised offline.
import { defineSetupCli, serve } from "../../../src/setup-cli.ts";

const tenants = new Map<string, { greeting: string }>();

await serve(
  defineSetupCli({
    id: "sample",
    inputs: [
      { key: "greeting", type: "string", scope: "tenant", title: "Greeting shown to users", default: "hello" },
      { key: "apiKey", type: "secret", scope: "tenant", title: "Upstream API key", required: false, perStage: true },
    ],
    checks: [
      {
        id: "sample.instance.reachable",
        scope: "instance",
        title: "Service instance answers its discovery probe",
        access: "public",
        humanOnly: true,
        dependsOn: ["cloudflare.worker.api.<stage>"],
        probe: () => ({ state: "missing", waitingFor: "blueprinter setup in the service repo" }),
      },
      {
        id: "sample.instance.signing-key",
        scope: "instance",
        title: "Signing key exists",
        dependsOn: ["sample.instance.reachable"],
        probe: () => ({ state: "missing" }),
        plan: (ctx) => ({ summary: ctx.rotate ? "Rotate the signing key" : "Create the signing key" }),
        fix: () => ({ outputs: { SAMPLE_SIGNING_KEY: "generated", SAMPLE_RECORDS: [{ type: "TXT", value: "v=sample" }] } }),
      },
      {
        id: "sample.tenant",
        scope: "tenant",
        title: "Tenant exists",
        dependsOn: ["cloudflare.worker.api.<stage>", "deploy.staging"],
        probe: (ctx) => {
          const tenant = tenants.get(ctx.project.slug);
          if (!tenant) return { state: "missing", detail: `no tenant ${ctx.project.slug}` };
          return tenant.greeting === ctx.inputs.greeting ? { state: "ok" } : { state: "drifted", detail: "greeting differs" };
        },
        plan: (ctx) => ({ summary: `Create or update tenant ${ctx.project.slug}` }),
        fix: (ctx) => {
          ctx.setCredential("tenantSetupToken", "tst_in-memory");
          tenants.set(ctx.project.slug, { greeting: String(ctx.inputs.greeting ?? "hello") });
          return { outputs: { SAMPLE_CLIENT_SECRET: "shown-once", SAMPLE_TENANT_ID: ctx.project.slug, SAMPLE_CI_KEY: "ci-only" } };
        },
      },
      {
        id: "sample.tenant.webhook",
        scope: "tenant",
        title: "Webhook registered by a human",
        humanOnly: true,
        dependsOn: ["sample.tenant"],
        probe: () => ({ state: "missing", waitingFor: "a human to register the webhook" }),
      },
    ],
    teardown: (ctx) => (ctx.credentials.tenantSetupToken ? ["tenantSetupToken"] : []),
  }),
);
