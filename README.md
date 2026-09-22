# blueprinter-kit

The setup-CLI protocol, and nothing else: protocol types, the `serve` loop, the recipe JSON Schema, the conformance command and `verifyBootstrapToken`. A service builds its setup CLI on it so it speaks the protocol by construction. Nothing here knows about any particular service.

## Install

```sh
pnpm add github:hannu1337/blueprinter-kit#v1.0.0
# or: npm install github:hannu1337/blueprinter-kit#v1.0.0
```

The `prepare` script builds `dist/` at install. pnpm (10.26 and later) runs it only for allowed packages, so add the kit to `onlyBuiltDependencies`:

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - blueprinter-kit
```

Node 22.18 or later.

## Entries

| Import | Runs on | Holds |
| --- | --- | --- |
| `blueprinter-kit` | Workers, Node | protocol types and constants, `verifyBootstrapToken`, `issueBootstrapToken`, `bootstrapTokenKey` |
| `blueprinter-kit/setup-cli` | Node | `defineSetupCli`, `serve`, `runSetupCli`, `SetupCliError` |
| `blueprinter-kit/recipe` | Node | `validateRecipe`, `recipeSchema`, `Recipe` |
| `blueprinter-kit/conformance` | Node | `runConformance`, `formatReport`, `CONFORMANCE_CHECKS` |
| `blueprinter-kit/recipe.schema.json` | any | the recipe JSON Schema (draft 2020-12) |
| `blueprinter-kit conformance` (bin) | Node | the conformance command |

## Writing a setup CLI

```ts
// app/setup-cli/src/main.ts
import { defineSetupCli, serve } from "blueprinter-kit/setup-cli";

await serve(
  defineSetupCli({
    id: "sample", // the recipe id: every check id starts with "sample."
    inputs: [{ key: "greeting", type: "string", scope: "tenant", title: "Greeting" }],
    checks: [
      {
        id: "sample.tenant",
        scope: "tenant", // run from a consumer project; "instance" runs in the service's own repository
        title: "Tenant exists",
        dependsOn: ["cloudflare.worker.api.<stage>"], // own checks of the same scope, or stable core check ids
        // access defaults to "service-token": without the token the probe reports no-access, unrun
        probe: async (ctx) => ({ state: "missing", detail: `no tenant ${ctx.project.slug}` }),
        plan: async (ctx) => ({ summary: `Create tenant ${ctx.project.slug}` }),
        fix: async (ctx) => {
          ctx.setCredential("tenantSetupToken", "…"); // minted for this run, handed back on later calls
          return { outputs: { SAMPLE_CLIENT_SECRET: "…" } };
        },
      },
      {
        id: "sample.tenant.webhook",
        scope: "tenant",
        title: "Webhook registered",
        humanOnly: true, // no plan, no fix: the probe verifies what a human did
        probe: async () => ({ state: "missing", waitingFor: "a human to register the webhook" }),
      },
    ],
    teardown: async (ctx) => (ctx.credentials.tenantSetupToken ? ["tenantSetupToken"] : []),
  }),
);
```

`defineSetupCli` throws on a check id outside the namespace, a dependency that is neither an own check of the same scope nor a stable core check id, a dependency cycle, a human-only check with a fix, and a check that is neither fixable nor human-only.

`serve` handles one call per process. Every stdout write other than the envelope (including `console.log`) goes to stderr. `ctx.log` writes to stderr. Credentials and `secret` inputs are replaced by `***` in logs and error messages. A handler that throws `SetupCliError(code, message, hint?)` produces that error envelope. Anything else it throws produces `internal`. Plan and fix never run without the service bootstrap token (`no-credential`), and human-only checks answer `not-fixable`.

## The protocol (version 1)

The caller runs `<entry> <command> [checkId] [--rotate]`, where `command` is `describe`, `probe`, `plan`, `fix` or `teardown`. It writes one JSON request to stdin and reads one JSON envelope from stdout:

```jsonc
// stdin (describe reads nothing and must work with stdin closed)
{
  "protocolVersion": 1,
  "command": "fix",
  "scope": "tenant",               // tenant | instance; must match the check
  "checkId": "sample.tenant",
  "rotate": false,
  "project": { "slug": "shop", "stage": "staging", "zone": "example.test", "hostnames": ["staging.shop.example.test"] },
  "inputs": { "greeting": "hello" },
  "credentials": { "serviceBootstrapToken": "bkt_…", "tenantSetupToken": "…" }
}
// stdout
{ "ok": true, "result": { … }, "credentials": { "tenantSetupToken": "…" } }
{ "ok": false, "error": { "code": "no-credential", "message": "…", "hint": "…" } }
```

The process exits 0 with `ok: true` and 1 with `ok: false`. The state of a check is in the result, never in the exit code. The results are:

| Command | Result |
| --- | --- |
| `describe` | `{ protocolVersion, id, inputs: InputSpec[], checks: CheckSpec[] }` |
| `probe` | `{ state: ok \| missing \| drifted \| no-access, detail?, waitingFor? }` |
| `plan` | `{ summary, details? }` |
| `fix` | `{ outputs: { NAME: value } }`, with show-once values included |
| `teardown` | `{ revoked: string[] }`, holding names only |

The error codes are `bad-request`, `unsupported-protocol`, `unknown-command`, `unknown-check`, `scope-mismatch`, `not-fixable`, `no-credential`, `service-error` and `internal`.

The stable core check ids a `dependsOn` may name are `github.repo`, `deploy.staging`, `cloudflare.zone.<stage>`, `cloudflare.worker.web.<stage>` and `cloudflare.worker.api.<stage>`. `<stage>` stands for the stage of the run (see `resolveDependency`).

## The recipe

`.integration/recipe.json` is validated by `schema/recipe.schema.json` and `validateRecipe`:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "id": "sample",
  "name": "Sample",
  "setupCli": { "install": "pnpm install --frozen-lockfile", "entry": "pnpm --silent setup-cli", "timeoutSeconds": 120 },
  "credential": { "kind": "cloudflare-kv", "namespace": "sample-operators-<stage>", "ttlMax": "PT1H" },
  "outputs": [
    { "name": "SAMPLE_CLIENT_SECRET", "scope": "tenant", "secret": true, "target": "web" },
    { "name": "SAMPLE_RECORDS", "scope": "instance", "secret": false, "target": "terraform" }
  ],
  "overlay": ".integration/overlay"
}
```

Each output has a `target`:

- `api` or `web`: a Worker secret when `secret` is true, a wrangler var when it is false.
- `ci`: a test-only GitHub environment secret. `secret` must be true.
- `terraform`: non-secret Terraform input. Allowed only for `instance` outputs.

`ttlMax` must be between PT1M and PT1H.

## Conformance

```sh
blueprinter-kit conformance [dir] [--entry "<command>"] [--timeout <seconds>] [--json]
```

The command runs these checks against the repository in `dir` without contacting any service:

- the recipe schema
- `describe` with closed stdin and within the timeout
- the check-id namespace
- `dependsOn`, which may name only own checks of the same scope or stable core ids, with no cycles
- human-only and fix consistency
- token probes that report `no-access` without the token
- error envelopes
- `teardown` without credentials
- overlay paths

`--entry` checks any setup CLI, whether or not it is built on the kit. The command exits 0 when everything passes, 1 when a check fails and 2 on bad usage.

An integration overlay may add only these paths:

- `docs/integrations/<id>.md`, which is required and needs a heading about removal
- `infra/terraform/integration-<id>.tf`
- `app/api/src/integrations/<id>/**`
- `app/web/layers/integration-<id>/**`
- `app/api/.dev.vars.example` and `app/web/.dev.vars.example` (fragments)

It may not contain symlinks.

## Service bootstrap tokens

The caller issues the token for one run:

```ts
import { issueBootstrapToken } from "blueprinter-kit";

const { token, key, record, expirationTtl } = await issueBootstrapToken({ scope: "tenants", ttlSeconds: 3600 });
// Write JSON.stringify(record) under `key` with `expirationTtl`, pass `token` on stdin, delete `key` when the run ends.
```

The service checks the token in its Worker:

```ts
import { verifyBootstrapToken } from "blueprinter-kit";

const result = await verifyBootstrapToken(env.OPERATORS, bearerToken, { scope: "tenants", tenant: slug });
if (!result.ok) return new Response(null, { status: 401 }); // result.reason says why
```

A token is `bkt_` followed by 256 random bits in base64url. KV holds only `sha256(token)` mapped to `{ scope, tenant?, expiresAt }`. The scopes are `tenants` and `instance`, never both. A token restricted to a tenant is accepted only for that tenant, and `expiresAt` is checked even while KV still holds the key.

## Versions

A major release changes `protocolVersion`, and only a major release may change the protocol. Releases are git tags `vX.Y.Z`.

## Contributing

Every commit on `main` is a release:

- The message is exactly `vX.Y.Z`, with no body and no trailers.
- The author and committer are `Hannu1337 <2278848+hannu1337@users.noreply.github.com>`.
- Changes land as squash merges of reviewed pull requests whose title is `vX.Y.Z` and whose body is empty.
- `package.json` carries the same version.

Three places enforce this:

- `.githooks/commit-msg`, which `npm install` enables through `core.hooksPath`.
- A Claude Code `PreToolUse` hook in `.claude/settings.json`.
- The `release-rules` CI check. After a merge, CI tags the release.

```sh
npm install
npm run gates   # typecheck, tests, build, conformance of the sample
```
