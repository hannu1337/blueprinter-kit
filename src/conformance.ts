/**
 * The conformance command: checks a service repository against the setup-CLI
 * contract without touching any service. It takes any setup-CLI entry, so
 * setup CLIs not built on the kit can run it too.
 */
import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  ACCESS_KINDS,
  CHECK_ID_PATTERN,
  INPUT_TYPES,
  PROTOCOL_VERSION,
  SCOPES,
  isStableCoreCheckId,
  type CheckSpec,
  type Command,
  type DescribeResult,
  type Envelope,
  type Request,
} from "./protocol.ts";
import { RECIPE_PATH, validateRecipe, type Recipe } from "./recipe.ts";
import { checkOverlayPaths } from "./overlay.ts";

export const CONFORMANCE_CHECKS = [
  { id: "recipe", title: "recipe.json validates against the recipe schema" },
  { id: "describe", title: "describe answers with closed stdin, within the timeout, with one JSON envelope" },
  { id: "check-ids", title: "check ids are unique and inside the recipe id's namespace" },
  { id: "depends-on", title: "dependsOn names only own checks of the same scope or stable core check ids" },
  { id: "human-only", title: "human-only checks refuse plan and fix; every other check has a fix" },
  { id: "no-access", title: "token probes report no-access without the service bootstrap token" },
  { id: "error-envelope", title: "failures answer with an error envelope and a non-zero exit" },
  { id: "teardown", title: "teardown succeeds without credentials" },
  { id: "overlay", title: "the overlay adds only allowed paths and documents its removal" },
] as const;
export type ConformanceCheckId = (typeof CONFORMANCE_CHECKS)[number]["id"];

export interface ConformanceCheckResult {
  id: ConformanceCheckId;
  title: string;
  ok: boolean;
  /** True when the check could not run because an earlier one failed. */
  skipped?: boolean;
  problems: string[];
}

export interface ConformanceReport {
  ok: boolean;
  dir: string;
  entry?: string;
  checks: ConformanceCheckResult[];
}

export interface ConformanceOptions {
  /** The service repository (or any folder holding `.integration/`). */
  dir: string;
  /** Overrides the recipe's `setupCli.entry`. */
  entry?: string;
  /** Overrides the recipe's `setupCli.timeoutSeconds` (default 60). */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;

const CONFORMANCE_PROJECT = {
  slug: "conformance",
  stage: "staging",
  zone: "conformance.invalid",
  hostnames: ["staging.conformance.invalid"],
} as const;

interface CallResult {
  exitCode: number | null;
  envelope?: Envelope<unknown>;
  problem?: string;
  stderr: string;
}

function describeCall(args: string[]) {
  return args.join(" ");
}

async function callSetupCli(dir: string, entry: string, args: string[], stdin: Request | undefined, timeoutSeconds: number): Promise<CallResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", `${entry} "$@"`, "setup-cli", ...args], {
      cwd: dir,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSeconds * 1000);
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(stdin));
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, problem: `could not start: ${error.message}`, stderr });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const call = describeCall(args);
      if (timedOut) return resolvePromise({ exitCode, problem: `${call}: timed out after ${timeoutSeconds}s`, stderr });
      let envelope: unknown;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        return resolvePromise({
          exitCode,
          problem: `${call}: exited with ${exitCode}; stdout is not one JSON document${stdout.trim() ? `: ${JSON.stringify(stdout.slice(0, 200))}` : " (empty)"}${tail ? `; stderr: ${tail}` : ""}`,
          stderr,
        });
      }
      const e = envelope as Record<string, unknown>;
      const valid =
        typeof e === "object" && e !== null &&
        ((e.ok === true && "result" in e) ||
          (e.ok === false && typeof e.error === "object" && e.error !== null && typeof (e.error as Record<string, unknown>).code === "string" && typeof (e.error as Record<string, unknown>).message === "string"));
      if (!valid) return resolvePromise({ exitCode, problem: `${call}: stdout is not a protocol envelope: ${stdout.slice(0, 200)}`, stderr });
      const env = envelope as Envelope<unknown>;
      if ((env.ok && exitCode !== 0) || (!env.ok && exitCode === 0)) {
        return resolvePromise({ exitCode, envelope: env, problem: `${call}: exit code ${exitCode} does not match ok: ${env.ok}`, stderr });
      }
      resolvePromise({ exitCode, envelope: env, stderr });
    });
  });
}

function request(command: Command, extra: Partial<Request> = {}): Request {
  return {
    protocolVersion: PROTOCOL_VERSION,
    command,
    project: { ...CONFORMANCE_PROJECT, hostnames: [...CONFORMANCE_PROJECT.hostnames] },
    inputs: {},
    credentials: {},
    ...extra,
  };
}

function describeProblems(result: unknown, recipe: Recipe | undefined): string[] {
  const problems: string[] = [];
  const r = result as Partial<DescribeResult> | null;
  if (typeof r !== "object" || r === null) return ["describe result is not an object"];
  if (r.protocolVersion !== PROTOCOL_VERSION) problems.push(`describe says protocolVersion ${JSON.stringify(r.protocolVersion)}, this kit checks ${PROTOCOL_VERSION}`);
  if (recipe && r.protocolVersion !== recipe.protocolVersion) problems.push(`describe says protocolVersion ${JSON.stringify(r.protocolVersion)}, the recipe ${recipe.protocolVersion}`);
  if (typeof r.id !== "string") problems.push("describe result has no id");
  else if (recipe && r.id !== recipe.id) problems.push(`describe says id ${r.id}, the recipe ${recipe.id}`);
  if (!Array.isArray(r.inputs)) problems.push("describe result has no inputs array");
  else
    for (const input of r.inputs as unknown as Record<string, unknown>[]) {
      if (typeof input?.key !== "string" || !INPUT_TYPES.includes(input.type as never) || !SCOPES.includes(input.scope as never) || typeof input.perStage !== "boolean" || typeof input.required !== "boolean" || typeof input.title !== "string") {
        problems.push(`malformed input ${JSON.stringify(input)}`);
      }
    }
  if (!Array.isArray(r.checks)) problems.push("describe result has no checks array");
  else
    for (const check of r.checks as unknown as Record<string, unknown>[]) {
      if (typeof check?.id !== "string" || !SCOPES.includes(check.scope as never) || typeof check.title !== "string" || !Array.isArray(check.dependsOn) || !check.dependsOn.every((d) => typeof d === "string") || !ACCESS_KINDS.includes(check.access as never) || typeof check.humanOnly !== "boolean") {
        problems.push(`malformed check ${JSON.stringify(check)}`);
      }
    }
  return problems;
}

async function listFiles(root: string): Promise<{ files: string[]; problems: string[] }> {
  const files: string[] = [];
  const problems: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) problems.push(`${rel} is a symlink; overlays hold only regular files`);
      else if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files.push(rel);
      else problems.push(`${rel} is not a regular file`);
    }
  };
  await walk(root);
  return { files: files.sort(), problems };
}

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const dir = resolve(options.dir);
  const results = new Map<ConformanceCheckId, ConformanceCheckResult>();
  const record = (id: ConformanceCheckId, problems: string[], skipped = false) => {
    const title = CONFORMANCE_CHECKS.find((c) => c.id === id)?.title ?? id;
    results.set(id, skipped ? { id, title, ok: false, skipped: true, problems } : { id, title, ok: problems.length === 0, problems });
  };

  // recipe
  let recipe: Recipe | undefined;
  {
    let raw: string | undefined;
    try {
      raw = await readFile(join(dir, RECIPE_PATH), "utf8");
    } catch {
      record("recipe", [`${RECIPE_PATH} not found in ${dir}`]);
    }
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        record("recipe", [`${RECIPE_PATH} is not JSON: ${(error as Error).message}`]);
      }
      if (parsed !== undefined) {
        const validation = validateRecipe(parsed);
        if (validation.ok) {
          recipe = validation.recipe;
          record("recipe", recipe.protocolVersion === PROTOCOL_VERSION ? [] : [`protocolVersion ${recipe.protocolVersion} is not ${PROTOCOL_VERSION}, the version this kit checks`]);
        } else record("recipe", validation.errors.map((e) => `${RECIPE_PATH}: ${e}`));
      }
    }
  }

  const entry = options.entry ?? recipe?.setupCli.entry;
  const timeoutSeconds = options.timeoutSeconds ?? recipe?.setupCli.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const call = (args: string[], stdin?: Request) => callSetupCli(dir, entry as string, args, stdin, timeoutSeconds);
  const skipAll = (ids: ConformanceCheckId[], why: string) => ids.forEach((id) => record(id, [why], true));

  if (entry === undefined) {
    skipAll(["describe", "check-ids", "depends-on", "human-only", "no-access", "error-envelope", "teardown"], "skipped: no setup-CLI entry (fix the recipe or pass --entry)");
  } else {
    // describe
    let checks: CheckSpec[] | undefined;
    let describedId: string | undefined;
    const described = await call(["describe"]);
    if (described.problem) record("describe", [described.problem]);
    else if (!described.envelope?.ok) record("describe", [`describe answered ${JSON.stringify(described.envelope)}`]);
    else {
      const problems = describeProblems(described.envelope.result, recipe);
      record("describe", problems);
      if (problems.length === 0) {
        const result = described.envelope.result as DescribeResult;
        checks = result.checks;
        describedId = result.id;
      }
    }

    if (!checks || describedId === undefined) {
      skipAll(["check-ids", "depends-on", "human-only", "no-access"], "skipped: describe failed");
    } else {
      // check-ids
      const namespace = `${recipe?.id ?? describedId}.`;
      const seen = new Set<string>();
      const idProblems: string[] = [];
      for (const check of checks) {
        if (!CHECK_ID_PATTERN.test(check.id)) idProblems.push(`${check.id} is not a lowercase dotted id`);
        if (!check.id.startsWith(namespace)) idProblems.push(`${check.id} is outside the namespace ${namespace}*`);
        if (seen.has(check.id)) idProblems.push(`${check.id} is declared twice`);
        seen.add(check.id);
      }
      record("check-ids", idProblems);

      // depends-on
      const byId = new Map(checks.map((c) => [c.id, c]));
      const depProblems: string[] = [];
      for (const check of checks) {
        for (const dep of check.dependsOn) {
          const own = byId.get(dep);
          if (own) {
            if (own.scope !== check.scope) depProblems.push(`${check.id} (${check.scope}) depends on ${dep} (${own.scope})`);
          } else if (!isStableCoreCheckId(dep)) {
            depProblems.push(`${check.id} depends on ${dep}, which is neither its own check nor a stable core check id`);
          }
        }
      }
      const state = new Map<string, "visiting" | "done">();
      const visit = (id: string, path: string[]): void => {
        if (state.get(id) === "done") return;
        if (state.get(id) === "visiting") {
          depProblems.push(`dependency cycle ${[...path, id].join(" -> ")}`);
          return;
        }
        state.set(id, "visiting");
        for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...path, id]);
        state.set(id, "done");
      };
      for (const id of byId.keys()) visit(id, []);
      record("depends-on", depProblems);

      // human-only and fix consistency
      const humanProblems: string[] = [];
      for (const check of checks) {
        const commands: Command[] = check.humanOnly ? ["plan", "fix"] : ["fix"];
        for (const command of commands) {
          const res = await call([command, check.id], request(command, { scope: check.scope, checkId: check.id }));
          const expected = check.humanOnly ? "not-fixable" : "no-credential";
          if (res.problem) humanProblems.push(res.problem);
          else if (res.envelope?.ok !== false || res.envelope.error.code !== expected) {
            humanProblems.push(
              check.humanOnly
                ? `${command} ${check.id}: a human-only check must answer not-fixable, got ${JSON.stringify(res.envelope)}`
                : `${command} ${check.id}: a check that is not human-only needs a fix, which refuses to run without the token (no-credential); got ${JSON.stringify(res.envelope)}`,
            );
          }
        }
      }
      record("human-only", humanProblems);

      // no-access
      const accessProblems: string[] = [];
      for (const check of checks.filter((c) => c.access === "service-token")) {
        const res = await call(["probe", check.id], request("probe", { scope: check.scope, checkId: check.id }));
        if (res.problem) accessProblems.push(res.problem);
        else if (!res.envelope?.ok || (res.envelope.result as { state?: unknown })?.state !== "no-access") {
          accessProblems.push(`probe ${check.id} without the token must report state no-access, got ${JSON.stringify(res.envelope)}`);
        }
      }
      record("no-access", accessProblems);
    }

    // error-envelope
    const envelopeProblems: string[] = [];
    const unknown = await call(["conformance-unknown-command"], request("probe"));
    if (unknown.problem) envelopeProblems.push(`unknown command: ${unknown.problem}`);
    else if (unknown.envelope?.ok !== false || unknown.envelope.error.code !== "unknown-command") {
      envelopeProblems.push(`unknown command must answer unknown-command, got ${JSON.stringify(unknown.envelope)}`);
    }
    const firstCheck = checks?.[0];
    if (firstCheck) {
      const future = await call(["probe", firstCheck.id], { ...request("probe", { scope: firstCheck.scope, checkId: firstCheck.id }), protocolVersion: 999 as never });
      if (future.problem) envelopeProblems.push(`unsupported protocol: ${future.problem}`);
      else if (future.envelope?.ok !== false || future.envelope.error.code !== "unsupported-protocol") {
        envelopeProblems.push(`protocolVersion 999 must answer unsupported-protocol, got ${JSON.stringify(future.envelope)}`);
      }
    }
    record("error-envelope", envelopeProblems);

    // teardown
    const teardown = await call(["teardown"], request("teardown"));
    if (teardown.problem) record("teardown", [teardown.problem]);
    else if (!teardown.envelope?.ok) record("teardown", [`teardown without credentials failed: ${JSON.stringify(teardown.envelope)}`]);
    else {
      const revoked = (teardown.envelope.result as { revoked?: unknown })?.revoked;
      record("teardown", Array.isArray(revoked) && revoked.every((r) => typeof r === "string") ? [] : ["teardown must return { revoked: string[] }"]);
    }
  }

  // overlay
  if (!recipe) record("overlay", ["skipped: needs a valid recipe"], true);
  else {
    const root = resolve(dir, recipe.overlay);
    if (!root.startsWith(dir + sep)) record("overlay", [`${recipe.overlay} is outside the repository`]);
    else {
      try {
        const { files, problems } = await listFiles(root);
        const pathProblems = checkOverlayPaths(recipe.id, files).map((p) => `${recipe.overlay}/${p.path} ${p.problem}`);
        const docPath = `docs/integrations/${recipe.id}.md`;
        if (files.includes(docPath)) {
          const doc = await readFile(join(root, docPath), "utf8");
          if (!/^#{1,6}\s.*remov/im.test(doc)) pathProblems.push(`${recipe.overlay}/${docPath} has no heading about removal`);
        }
        record("overlay", [...problems, ...pathProblems]);
      } catch {
        record("overlay", [`${recipe.overlay} not found`]);
      }
    }
  }

  const checks = CONFORMANCE_CHECKS.map(({ id }) => results.get(id) as ConformanceCheckResult);
  const report: ConformanceReport = { ok: checks.every((c) => c.ok), dir, checks };
  if (entry !== undefined) report.entry = entry;
  return report;
}

export function formatReport(report: ConformanceReport): string {
  const lines = [`conformance of ${report.dir}${report.entry ? ` (entry: ${report.entry})` : ""}`];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "ok  " : check.skipped ? "skip" : "FAIL"}  ${check.id}  ${check.title}`);
    for (const problem of check.problems) lines.push(`        ${problem}`);
  }
  lines.push(report.ok ? "conformant" : "not conformant");
  return lines.join("\n");
}
