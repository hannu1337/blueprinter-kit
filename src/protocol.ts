/**
 * The setup-CLI protocol, version 1.
 *
 * A setup CLI is a non-interactive program. The blueprinter calls it once per
 * command as `<entry> <command> [checkId] [--rotate]`, writes one JSON request
 * to its stdin and reads exactly one JSON envelope from its stdout. Logs go to
 * stderr only. The process exits 0 when the call itself worked (the state of a
 * check is in the result) and non-zero with an error envelope otherwise.
 *
 * Only a major release of the kit may change anything in this file.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const COMMANDS = ["describe", "probe", "plan", "fix", "teardown"] as const;
export type Command = (typeof COMMANDS)[number];

/** `tenant` checks run in a consumer project, `instance` checks in the service's own repository. */
export const SCOPES = ["tenant", "instance"] as const;
export type Scope = (typeof SCOPES)[number];

export const STAGES = ["staging", "production"] as const;
export type Stage = (typeof STAGES)[number];

export const CHECK_STATES = ["ok", "missing", "drifted", "no-access"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/**
 * What a check's probe needs: `public` probes need no credential,
 * `service-token` probes need the service bootstrap token. Every fix needs it.
 */
export const ACCESS_KINDS = ["public", "service-token"] as const;
export type Access = (typeof ACCESS_KINDS)[number];

export const INPUT_TYPES = ["string", "url", "enum", "list", "boolean", "secret"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export type InputValue = string | boolean | string[];

export interface InputSpec {
  key: string;
  type: InputType;
  scope: Scope;
  title: string;
  /** Asked once per stage (true) or once per integration (false). */
  perStage: boolean;
  required: boolean;
  default?: InputValue;
  validation?: {
    /** A regular expression every string (or list item) must match. */
    pattern?: string;
    /** The allowed values of an `enum` input. */
    values?: string[];
  };
}

export interface CheckSpec {
  /** `<recipe id>.<subject>[.<more>]`, lowercase. */
  id: string;
  scope: Scope;
  title: string;
  /** Checks of the same scope in this setup CLI, or stable core check ids. */
  dependsOn: string[];
  access: Access;
  /** A human-only check has no fix: its probe verifies an end state a human reaches. */
  humanOnly: boolean;
}

export interface DescribeResult {
  protocolVersion: ProtocolVersion;
  /** Equals the recipe's `id`. */
  id: string;
  inputs: InputSpec[];
  checks: CheckSpec[];
}

export interface ProjectContext {
  slug: string;
  stage: Stage;
  zone: string;
  hostnames: string[];
}

/**
 * Credentials the blueprinter holds in memory for one run and passes on every
 * call. `serviceBootstrapToken` is issued by the blueprinter; any other entry
 * was returned by an earlier call of this run (see `Envelope.credentials`).
 */
export type Credentials = { serviceBootstrapToken?: string } & Record<string, string | undefined>;

export interface Request {
  protocolVersion: ProtocolVersion;
  command: Command;
  /** Required for probe, plan and fix: must equal the check's scope. */
  scope?: Scope;
  checkId?: string;
  /** `fix --rotate`: rotate show-once secrets even when the check is ok. */
  rotate?: boolean;
  project?: ProjectContext;
  inputs?: Record<string, InputValue>;
  credentials?: Credentials;
}

export interface ProbeResult {
  state: CheckState;
  detail?: string;
  /** What a missing check waits for, such as a human step or another repository's setup. */
  waitingFor?: string;
}

/** One human-readable row of the blueprinter's plan table. */
export interface PlanResult {
  summary: string;
  details?: string[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface FixResult {
  /**
   * Values for the recipe's outputs, keyed by output name. Show-once secrets
   * are included. Worker and CI targets take strings; the `terraform` target
   * (instance scope only) takes any JSON value.
   */
  outputs: Record<string, JsonValue>;
}

export interface TeardownResult {
  /** Names of the credentials revoked, never their values. */
  revoked: string[];
}

export interface ResultByCommand {
  describe: DescribeResult;
  probe: ProbeResult;
  plan: PlanResult;
  fix: FixResult;
  teardown: TeardownResult;
}

export const ERROR_CODES = [
  "bad-request",
  "unsupported-protocol",
  "unknown-command",
  "unknown-check",
  "scope-mismatch",
  "not-fixable",
  "no-credential",
  "service-error",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type Envelope<T = unknown> =
  | {
      ok: true;
      result: T;
      /**
       * Credentials this call minted (for example a tenant setup token). The
       * blueprinter keeps them in memory, passes them on every later call of
       * the run and last to `teardown`, which revokes them.
       */
      credentials?: Record<string, string>;
    }
  | { ok: false; error: ProtocolError };

// ---------------------------------------------------------------------------
// Check ids

export const CHECK_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
export const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** The placeholder a `dependsOn` entry may use for the stage of the run. */
export const STAGE_PLACEHOLDER = "<stage>";

/**
 * The core check ids an integration may depend on (ADR-0013). Every other
 * core check id is internal to the blueprinter.
 */
export const STABLE_CORE_CHECK_IDS = [
  "github.repo",
  "deploy.staging",
  "cloudflare.zone.<stage>",
  "cloudflare.worker.web.<stage>",
  "cloudflare.worker.api.<stage>",
] as const;

export function isStableCoreCheckId(id: string): boolean {
  return STABLE_CORE_CHECK_IDS.some((pattern) =>
    pattern.endsWith(STAGE_PLACEHOLDER)
      ? [STAGE_PLACEHOLDER, ...STAGES].some((stage) => id === pattern.replace(STAGE_PLACEHOLDER, stage))
      : id === pattern,
  );
}

/** Replaces the `<stage>` placeholder of a `dependsOn` entry with the run's stage. */
export function resolveDependency(id: string, stage: Stage): string {
  return id.replace(STAGE_PLACEHOLDER, stage);
}

// ---------------------------------------------------------------------------
// Durations

/** Parses an ISO 8601 time-only duration such as `PT1H` or `PT15M` into seconds. */
export function parseDurationSeconds(duration: string): number | undefined {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match || duration === "PT") return undefined;
  const [, h = "0", m = "0", s = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
