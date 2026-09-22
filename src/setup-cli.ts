/**
 * Build a setup CLI that speaks the protocol by construction.
 *
 * ```ts
 * import { defineSetupCli, serve } from "blueprinter-kit/setup-cli";
 *
 * await serve(defineSetupCli({ id: "sample", inputs: [...], checks: [...], teardown }));
 * ```
 *
 * `defineSetupCli` rejects a definition that breaks the protocol (check ids
 * outside the namespace, dependencies other than own checks and stable core
 * ids, human-only checks with a fix). `serve` reads argv and stdin, answers
 * with exactly one JSON envelope on stdout and sends everything else,
 * including stray `console.log` output, to stderr.
 */
import {
  ACCESS_KINDS,
  CHECK_ID_PATTERN,
  CHECK_STATES,
  COMMANDS,
  INPUT_TYPES,
  PROTOCOL_VERSION,
  RECIPE_ID_PATTERN,
  SCOPES,
  STAGES,
  isStableCoreCheckId,
  type Access,
  type CheckSpec,
  type Command,
  type Credentials,
  type DescribeResult,
  type Envelope,
  type ErrorCode,
  type FixResult,
  type InputSpec,
  type InputValue,
  type PlanResult,
  type ProbeResult,
  type ProjectContext,
  type Scope,
  type Stage,
} from "./protocol.ts";

type MaybePromise<T> = T | Promise<T>;

export interface CheckContext {
  check: CheckSpec;
  scope: Scope;
  stage: Stage;
  project: ProjectContext;
  inputs: Record<string, InputValue>;
  credentials: Credentials;
  /** True for `fix --rotate`. */
  rotate: boolean;
  /** Writes one line to stderr, with credentials and secret inputs redacted. */
  log: (message: string) => void;
  /**
   * Hands a credential this run minted (such as a tenant setup token) back to
   * the blueprinter, which passes it on every later call and to `teardown`.
   */
  setCredential: (name: string, value: string) => void;
}

export interface TeardownContext {
  credentials: Credentials;
  log: (message: string) => void;
}

export interface CheckDefinition {
  id: string;
  scope: Scope;
  title: string;
  dependsOn?: string[];
  /** Defaults to `service-token`. */
  access?: Access;
  humanOnly?: boolean;
  probe: (ctx: CheckContext) => MaybePromise<ProbeResult>;
  plan?: (ctx: CheckContext) => MaybePromise<PlanResult>;
  fix?: (ctx: CheckContext) => MaybePromise<FixResult>;
}

export type InputDefinition = Omit<InputSpec, "perStage" | "required"> & { perStage?: boolean; required?: boolean };

export interface SetupCliDefinition {
  /** The recipe id; every check id starts with `<id>.`. */
  id: string;
  inputs?: InputDefinition[];
  checks: CheckDefinition[];
  /**
   * Revokes what this run minted. Called last in every run, also after a
   * failure, with whatever credentials the blueprinter holds; must tolerate
   * none. Returns the names of the credentials it revoked.
   */
  teardown?: (ctx: TeardownContext) => MaybePromise<string[] | void>;
}

export interface SetupCli {
  readonly id: string;
  readonly describe: DescribeResult;
  readonly definition: SetupCliDefinition;
}

/** Throw from a handler to answer with a specific error envelope. */
export class SetupCliError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "SetupCliError";
    this.code = code;
    this.hint = hint;
  }
}

function fail(message: string): never {
  throw new TypeError(`defineSetupCli: ${message}`);
}

export function defineSetupCli(definition: SetupCliDefinition): SetupCli {
  const { id } = definition;
  if (typeof id !== "string" || !RECIPE_ID_PATTERN.test(id)) fail(`id ${JSON.stringify(id)} must match ${RECIPE_ID_PATTERN}`);

  const inputs: InputSpec[] = (definition.inputs ?? []).map((input) => {
    if (!INPUT_TYPES.includes(input.type)) fail(`input ${input.key} has unknown type ${input.type}`);
    if (!SCOPES.includes(input.scope)) fail(`input ${input.key} has unknown scope ${input.scope}`);
    return { ...input, perStage: input.perStage ?? true, required: input.required ?? true };
  });
  const inputKeys = new Set<string>();
  for (const input of inputs) {
    if (inputKeys.has(input.key)) fail(`duplicate input ${input.key}`);
    inputKeys.add(input.key);
  }

  const byId = new Map<string, CheckDefinition>();
  for (const check of definition.checks) {
    if (!CHECK_ID_PATTERN.test(check.id) || !check.id.startsWith(`${id}.`)) {
      fail(`check id ${JSON.stringify(check.id)} must be lowercase and start with "${id}."`);
    }
    if (byId.has(check.id)) fail(`duplicate check id ${check.id}`);
    if (!SCOPES.includes(check.scope)) fail(`check ${check.id} has unknown scope ${String(check.scope)}`);
    if (check.access !== undefined && !ACCESS_KINDS.includes(check.access)) fail(`check ${check.id} has unknown access ${check.access}`);
    if (typeof check.probe !== "function") fail(`check ${check.id} has no probe`);
    const fixable = check.fix !== undefined;
    if ((check.plan !== undefined) !== fixable) fail(`check ${check.id} must define plan and fix together`);
    if (check.humanOnly && fixable) fail(`human-only check ${check.id} must not define a fix`);
    if (!check.humanOnly && !fixable) fail(`check ${check.id} has no fix, so it must be humanOnly`);
    byId.set(check.id, check);
  }
  for (const check of byId.values()) {
    for (const dep of check.dependsOn ?? []) {
      const own = byId.get(dep);
      if (own) {
        if (own.scope !== check.scope) fail(`check ${check.id} depends on ${dep} of another scope`);
      } else if (!isStableCoreCheckId(dep)) {
        fail(`check ${check.id} depends on ${dep}, which is neither its own check nor a stable core check id`);
      }
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (checkId: string, path: string[]) => {
    if (done.has(checkId)) return;
    if (visiting.has(checkId)) fail(`dependency cycle ${[...path, checkId].join(" -> ")}`);
    visiting.add(checkId);
    for (const dep of byId.get(checkId)?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...path, checkId]);
    visiting.delete(checkId);
    done.add(checkId);
  };
  for (const checkId of byId.keys()) visit(checkId, []);

  const checks: CheckSpec[] = definition.checks.map((check) => ({
    id: check.id,
    scope: check.scope,
    title: check.title,
    dependsOn: [...(check.dependsOn ?? [])],
    access: check.access ?? "service-token",
    humanOnly: check.humanOnly ?? false,
  }));

  return Object.freeze({
    id,
    definition,
    describe: { protocolVersion: PROTOCOL_VERSION, id, inputs, checks },
  });
}

// ---------------------------------------------------------------------------
// The loop

class RequestError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ParsedArgs {
  command: Command;
  checkId?: string;
  rotate: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) {
    throw new RequestError("unknown-command", `unknown command ${JSON.stringify(command ?? "")}; expected one of ${COMMANDS.join(", ")}`);
  }
  let checkId: string | undefined;
  let rotate = false;
  for (const arg of rest) {
    if (arg === "--rotate" && command === "fix") rotate = true;
    else if (!arg.startsWith("-") && checkId === undefined && ["probe", "plan", "fix"].includes(command)) checkId = arg;
    else throw new RequestError("bad-request", `unexpected argument ${JSON.stringify(arg)} for ${command}`);
  }
  return checkId === undefined ? { command: command as Command, rotate } : { command: command as Command, checkId, rotate };
}

function parseRequest(stdin: string, required: boolean): Record<string, unknown> {
  if (stdin.trim() === "") {
    if (required) throw new RequestError("bad-request", "expected one JSON request on stdin, got nothing");
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch {
    throw new RequestError("bad-request", "stdin is not one JSON document");
  }
  if (!isObject(value)) throw new RequestError("bad-request", "the request must be a JSON object");
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    if (value.protocolVersion === undefined && !required) return value;
    throw new RequestError(
      value.protocolVersion === undefined ? "bad-request" : "unsupported-protocol",
      `this setup CLI speaks protocolVersion ${PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`,
    );
  }
  return value;
}

function parseCredentials(value: unknown): Credentials {
  if (value === undefined) return {};
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new RequestError("bad-request", "credentials must map names to strings");
  }
  return value as Credentials;
}

function parseInputs(value: unknown): Record<string, InputValue> {
  if (value === undefined) return {};
  const ok = (v: unknown) =>
    typeof v === "string" || typeof v === "boolean" || (Array.isArray(v) && v.every((item) => typeof item === "string"));
  if (!isObject(value) || !Object.values(value).every(ok)) {
    throw new RequestError("bad-request", "inputs must map keys to strings, booleans or string lists");
  }
  return value as Record<string, InputValue>;
}

function parseProject(value: unknown): ProjectContext {
  if (
    !isObject(value) ||
    typeof value.slug !== "string" ||
    typeof value.zone !== "string" ||
    !STAGES.includes(value.stage as Stage) ||
    !Array.isArray(value.hostnames) ||
    !value.hostnames.every((h) => typeof h === "string")
  ) {
    throw new RequestError("bad-request", "project must be { slug, stage: staging|production, zone, hostnames: string[] }");
  }
  return { slug: value.slug, stage: value.stage as Stage, zone: value.zone, hostnames: [...(value.hostnames as string[])] };
}

function assertProbeResult(value: unknown): ProbeResult {
  if (
    !isObject(value) ||
    !CHECK_STATES.includes(value.state as ProbeResult["state"]) ||
    (value.detail !== undefined && typeof value.detail !== "string") ||
    (value.waitingFor !== undefined && typeof value.waitingFor !== "string")
  ) {
    throw new Error(`probe returned ${JSON.stringify(value)}, expected { state: ${CHECK_STATES.join("|")}, detail?, waitingFor? }`);
  }
  return value as unknown as ProbeResult;
}

function assertPlanResult(value: unknown): PlanResult {
  if (
    !isObject(value) ||
    typeof value.summary !== "string" ||
    (value.details !== undefined && !(Array.isArray(value.details) && value.details.every((d) => typeof d === "string")))
  ) {
    throw new Error("plan must return { summary: string, details?: string[] }");
  }
  return value as unknown as PlanResult;
}

function assertFixResult(value: unknown): FixResult {
  if (!isObject(value) || !isObject(value.outputs) || Object.values(value.outputs).some((v) => v === undefined)) {
    throw new Error("fix must return { outputs: { NAME: value } }");
  }
  return value as unknown as FixResult;
}

function redactor(secrets: Iterable<string>): (text: string) => string {
  const values = [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => values.reduce((out, secret) => out.split(secret).join("***"), text);
}

export interface RunOptions {
  argv: string[];
  stdin: string;
  stderr: (chunk: string) => void;
}

export interface RunResult {
  /** Exactly one JSON envelope and a newline. */
  stdout: string;
  exitCode: 0 | 1;
}

/**
 * Handles one protocol call without touching the process. `serve` wraps this;
 * tests and other hosts can call it directly.
 */
export async function runSetupCli(cli: SetupCli, options: RunOptions): Promise<RunResult> {
  let redact = (text: string) => text;
  const log = (message: string) => options.stderr(`${redact(message)}\n`);
  const minted: Record<string, string> = {};

  const handle = async (): Promise<unknown> => {
    const args = parseArgs(options.argv);
    if (args.command === "describe") return cli.describe;

    const raw = parseRequest(options.stdin, args.command !== "teardown");
    if (raw.command !== undefined && raw.command !== args.command) {
      throw new RequestError("bad-request", `argv says ${args.command} but the request says ${String(raw.command)}`);
    }
    const credentials = parseCredentials(raw.credentials);
    const secretInputKeys = new Set(cli.describe.inputs.filter((i) => i.type === "secret").map((i) => i.key));
    const inputs = parseInputs(raw.inputs);
    redact = redactor([
      ...Object.values(credentials).filter((v): v is string => typeof v === "string"),
      ...Object.entries(inputs)
        .filter(([key]) => secretInputKeys.has(key))
        .flatMap(([, v]) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])),
    ]);

    if (args.command === "teardown") {
      const revoked = (await cli.definition.teardown?.({ credentials, log })) ?? [];
      return { revoked };
    }

    if (args.checkId !== undefined && raw.checkId !== undefined && raw.checkId !== args.checkId) {
      throw new RequestError("bad-request", `argv names ${args.checkId} but the request names ${String(raw.checkId)}`);
    }
    const checkId = args.checkId ?? raw.checkId;
    if (typeof checkId !== "string") throw new RequestError("bad-request", `${args.command} needs a check id`);
    const check = cli.definition.checks.find((c) => c.id === checkId);
    const spec = cli.describe.checks.find((c) => c.id === checkId);
    if (!check || !spec) throw new RequestError("unknown-check", `no check ${checkId}`);
    if (!SCOPES.includes(raw.scope as Scope)) throw new RequestError("bad-request", "the request needs scope: tenant|instance");
    if (raw.scope !== check.scope) {
      throw new RequestError("scope-mismatch", `${checkId} is a ${check.scope} check, the request is for ${String(raw.scope)}`);
    }
    const project = parseProject(raw.project);
    const ctx: CheckContext = {
      check: spec,
      scope: check.scope,
      stage: project.stage,
      project,
      inputs,
      credentials,
      rotate: args.rotate || raw.rotate === true,
      log,
      setCredential: (name, value) => {
        minted[name] = value;
      },
    };
    const hasToken = typeof credentials.serviceBootstrapToken === "string" && credentials.serviceBootstrapToken !== "";

    if (args.command === "probe") {
      if (spec.access === "service-token" && !hasToken) return { state: "no-access", detail: "needs the service bootstrap token" };
      return assertProbeResult(await check.probe(ctx));
    }
    if (!check.fix || !check.plan) {
      throw new RequestError("not-fixable", `${checkId} is human-only; its probe verifies the end state`);
    }
    if (!hasToken) throw new RequestError("no-credential", `${args.command} ${checkId} needs the service bootstrap token`);
    return args.command === "plan" ? assertPlanResult(await check.plan(ctx)) : assertFixResult(await check.fix(ctx));
  };

  let envelope: Envelope;
  try {
    const result = await handle();
    envelope = Object.keys(minted).length > 0 ? { ok: true, result, credentials: minted } : { ok: true, result };
  } catch (error) {
    if (error instanceof RequestError || error instanceof SetupCliError) {
      const hint = error instanceof SetupCliError ? error.hint : undefined;
      envelope = {
        ok: false,
        error: hint === undefined ? { code: error.code, message: redact(error.message) } : { code: error.code, message: redact(error.message), hint: redact(hint) },
      };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      log(`internal error: ${error instanceof Error && error.stack ? error.stack : message}`);
      envelope = { ok: false, error: { code: "internal", message: redact(message) } };
    }
  }
  return { stdout: `${JSON.stringify(envelope)}\n`, exitCode: envelope.ok ? 0 : 1 };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs one protocol call for this process: reads argv and (except for
 * `describe`) stdin, keeps stdout for the one envelope by routing every other
 * stdout write to stderr, and sets the exit code.
 */
export async function serve(cli: SetupCli, argv: string[] = process.argv.slice(2)): Promise<void> {
  const stdout = process.stdout;
  const writeStdout = stdout.write.bind(stdout);
  const writeStderr = process.stderr.write.bind(process.stderr);
  stdout.write = ((chunk: unknown, ...rest: unknown[]) => (writeStderr as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof stdout.write;
  let result: RunResult;
  try {
    const stdin = argv[0] === "describe" ? "" : await readStdin();
    result = await runSetupCli(cli, { argv, stdin, stderr: (chunk) => void writeStderr(chunk) });
  } finally {
    stdout.write = writeStdout;
  }
  process.exitCode = result.exitCode;
  await new Promise<void>((resolve) => writeStdout(result.stdout, () => resolve()));
}
