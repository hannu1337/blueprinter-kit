/**
 * Release discipline for this public repository: every commit is a release
 * whose message is exactly `vX.Y.Z` (no body, no trailers), authored and
 * committed by the owner's GitHub noreply identity.
 *
 * One file, three enforcers:
 *   node scripts/release-rules.ts commit-msg <file>   the committed git hook (.githooks/commit-msg)
 *   node scripts/release-rules.ts claude-hook         the Claude Code PreToolUse hook (.claude/settings.json)
 *   node scripts/release-rules.ts ci                  the required CI check (.github/workflows/ci.yml)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const OWNER = { name: "Hannu1337", email: "2278848+hannu1337@users.noreply.github.com" } as const;
/** The committer GitHub records for a squash merge made on github.com. */
export const WEB_FLOW = { name: "GitHub", email: "noreply@github.com" } as const;

const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RULE = "the message must be exactly vX.Y.Z (no body, no trailers)";

export function isReleaseVersion(value: string): boolean {
  return VERSION.test(value);
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.slice(1).split(".").map(Number);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Checks a commit message as the commit-msg hook sees it (git comment lines are ignored). */
export function checkCommitMessage(raw: string): string[] {
  const lines = raw.split("\n").filter((line) => !line.startsWith("#"));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length === 1 && isReleaseVersion(lines[0] ?? "")) return [];
  return [`${RULE}; got ${JSON.stringify(lines.join("\n"))}`];
}

export function checkIdentity(role: "author" | "committer", name: string, email: string, options: { allowWebFlow?: boolean } = {}): string[] {
  if (name === OWNER.name && email === OWNER.email) return [];
  if (options.allowWebFlow && role === "committer" && name === WEB_FLOW.name && email === WEB_FLOW.email) return [];
  return [`the ${role} must be "${OWNER.name} <${OWNER.email}>" (the owner's GitHub noreply identity), got "${name} <${email}>"`];
}

export function checkPullRequest(pr: { title: string; body: string | null }): string[] {
  const problems: string[] = [];
  if (!isReleaseVersion(pr.title)) problems.push(`the pull request title becomes the squash commit message, so it must be exactly vX.Y.Z; got ${JSON.stringify(pr.title)}`);
  if ((pr.body ?? "").trim() !== "") problems.push("the pull request body must be empty; the reasons for a change live in the private blueprinter's issues");
  return problems;
}

// ---------------------------------------------------------------------------
// Shell commands (for the Claude Code hook)

interface Word {
  text: string;
  /** Contains `$...` or backticks outside single quotes, so its value is unknown until the shell runs. */
  dynamic: boolean;
}

/** Splits a command line into simple commands of words. Approximate, but errs on the side of blocking. */
export function tokenize(command: string): Word[][] {
  const segments: Word[][] = [[]];
  let word: Word | undefined;
  const push = () => {
    if (word) segments.at(-1)?.push(word);
    word = undefined;
  };
  const cur = () => (word ??= { text: "", dynamic: false });
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur().text += command.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? command.length : end;
    } else if (c === '"') {
      const w = cur();
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && i + 1 < command.length) w.text += command[++i];
        else {
          if (command[i] === "$" || command[i] === "`") w.dynamic = true;
          w.text += command[i];
        }
      }
    } else if (c === "\\" && i + 1 < command.length) {
      cur().text += command[++i];
    } else if (c === "$" || c === "`") {
      const w = cur();
      w.dynamic = true;
      w.text += c;
    } else if (/\s/.test(c) && c !== "\n") {
      push();
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      push();
      segments.push([]);
    } else {
      cur().text += c;
    }
  }
  push();
  return segments.filter((s) => s.length > 0);
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

export interface ShellContext {
  /** user.name / user.email as the repository's git config resolves them. */
  repoIdentity: { name: string; email: string };
  /** The environment the command would inherit. */
  env: Record<string, string | undefined>;
}

function checkGitCommit(args: Word[], config: Map<string, Word>, env: Map<string, Word>, ctx: ShellContext): string[] {
  const problems: string[] = [];
  const messages: Word[] = [];
  let author: Word | undefined;
  const valueFlags = new Set(["m", "F", "C", "c", "t"]);
  const forbidden: Record<string, string> = {
    n: "--no-verify skips the commit-msg hook",
    "no-verify": "--no-verify skips the commit-msg hook",
    F: "messages must be given with -m",
    file: "messages must be given with -m",
    C: "reusing another message is not allowed",
    c: "reusing another message is not allowed",
    "reuse-message": "reusing another message is not allowed",
    "reedit-message": "reusing another message is not allowed",
    t: "templates are not allowed",
    template: "templates are not allowed",
    fixup: "fixup commits are not releases",
    squash: "squash! commits are not releases",
    trailer: "trailers are not allowed",
    s: "sign-off adds a trailer",
    signoff: "sign-off adds a trailer",
    "allow-empty-message": "the message must be vX.Y.Z",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (text === "--") break;
    if (text.startsWith("--")) {
      const [flag = "", inline] = text.slice(2).split(/=(.*)/s, 2);
      const value = inline !== undefined ? { text: inline, dynamic: arg.dynamic } : undefined;
      if (forbidden[flag]) problems.push(`git commit --${flag}: ${forbidden[flag]}`);
      else if (flag === "message") {
        const v = value ?? args[++i];
        if (v) messages.push(v);
      } else if (flag === "author") author = value ?? args[++i];
    } else if (text.startsWith("-") && text.length > 1) {
      for (let j = 1; j < text.length; j++) {
        const flag = text[j] as string;
        if (forbidden[flag]) problems.push(`git commit -${flag}: ${forbidden[flag]}`);
        if (valueFlags.has(flag)) {
          const rest = text.slice(j + 1);
          const v = rest !== "" ? { text: rest, dynamic: arg.dynamic } : args[++i];
          if (flag === "m" && v) messages.push(v);
          break;
        }
      }
    }
  }
  if (messages.length > 1) problems.push(`several -m flags add a body; ${RULE}`);
  for (const message of messages) {
    if (message.dynamic) problems.push(`the message must be a literal vX.Y.Z, not built by the shell (${JSON.stringify(message.text)})`);
    else problems.push(...checkCommitMessage(message.text));
  }

  // git's precedence: GIT_* environment variables, then configuration (-c beats the repository's).
  const fromEnv = (key: string): Word | undefined =>
    env.get(key) ?? (ctx.env[key] ? { text: ctx.env[key] as string, dynamic: false } : undefined);
  const name = config.get("user.name") ?? { text: ctx.repoIdentity.name, dynamic: false };
  const email = config.get("user.email") ?? { text: ctx.repoIdentity.email, dynamic: false };
  const identities: Array<["author" | "committer", Word, Word]> = [
    ["author", fromEnv("GIT_AUTHOR_NAME") ?? name, fromEnv("GIT_AUTHOR_EMAIL") ?? email],
    ["committer", fromEnv("GIT_COMMITTER_NAME") ?? name, fromEnv("GIT_COMMITTER_EMAIL") ?? email],
  ];
  for (const [role, name, email] of identities) {
    if (name.dynamic || email.dynamic) problems.push(`the ${role} identity must be literal`);
    else problems.push(...checkIdentity(role, name.text, email.text));
  }
  if (author) {
    const expected = `${OWNER.name} <${OWNER.email}>`;
    if (author.dynamic || author.text !== expected) problems.push(`--author must be "${expected}", got ${JSON.stringify(author.text)}`);
  }
  return problems;
}

function checkGhPr(sub: string, args: Word[]): string[] {
  const problems: string[] = [];
  const values = new Map<string, Word>();
  const flags = new Set<string>();
  const aliases: Record<string, string> = { t: "title", b: "body", F: "body-file", f: "fill", T: "template", w: "web", m: "merge", r: "rebase", s: "squash" };
  const takesValue = new Set(["title", "body", "body-file", "template", "subject", "base", "head", "assignee", "label", "milestone", "project", "reviewer", "repo", "R", "add-label", "remove-label", "add-reviewer", "add-assignee", "match-head-commit", "author-email"]);
  for (let i = 0; i < args.length; i++) {
    const text = (args[i] as Word).text;
    if (!text.startsWith("-")) continue;
    let [flag = "", inline] = text.replace(/^--?/, "").split(/=(.*)/s, 2);
    if (!text.startsWith("--")) flag = aliases[flag] ?? flag;
    flags.add(flag);
    if (takesValue.has(flag) && inline === undefined) {
      const next = args[++i];
      if (next) values.set(flag, next);
    } else if (inline !== undefined) values.set(flag, { text: inline, dynamic: (args[i] as Word).dynamic });
  }
  const title = values.get(sub === "merge" ? "subject" : "title");
  const body = values.get("body");
  for (const flag of ["fill", "fill-first", "fill-verbose", "body-file", "template", "web", "editor"]) {
    if (flags.has(flag)) problems.push(`gh pr ${sub} --${flag}: title and body must be given literally`);
  }
  if (sub === "merge") {
    if (flags.has("merge") || flags.has("rebase")) problems.push("only squash merges are allowed");
  }
  if (sub === "create" && !title) problems.push("gh pr create needs --title vX.Y.Z");
  if (sub === "create" && !body) problems.push('gh pr create needs --body "" (an empty body)');
  if (title && (title.dynamic || !isReleaseVersion(title.text))) problems.push(`the title must be exactly vX.Y.Z, got ${JSON.stringify(title.text)}`);
  if (body && (body.dynamic || body.text.trim() !== "")) problems.push("the body must be empty");
  return problems;
}

/** Returns the reasons to block a Bash command, or nothing when it may run. */
export function checkShellCommand(command: string, ctx: ShellContext): string[] {
  const problems: string[] = [];
  for (const segment of tokenize(command)) {
    const env = new Map<string, Word>();
    let i = 0;
    for (; i < segment.length; i++) {
      const match = ENV_ASSIGNMENT.exec((segment[i] as Word).text);
      if (!match) break;
      env.set(match[1] as string, { text: match[2] as string, dynamic: (segment[i] as Word).dynamic });
    }
    const words = segment.slice(i);
    const [tool, ...rest] = words;
    if (tool?.text === "git") {
      const config = new Map<string, Word>();
      let j = 0;
      for (; j < rest.length; j++) {
        const text = (rest[j] as Word).text;
        if (text === "-c") {
          const kv = rest[++j];
          const [key = "", value = ""] = (kv?.text ?? "").split(/=(.*)/s, 2);
          config.set(key.toLowerCase(), { text: value, dynamic: kv?.dynamic ?? false });
        } else if (text === "-C" || text === "--git-dir" || text === "--work-tree" || text === "--namespace") j++;
        else if (!text.startsWith("-")) break;
      }
      if (rest[j]?.text === "commit") problems.push(...checkGitCommit(rest.slice(j + 1), config, env, ctx));
    } else if (tool?.text === "gh" && rest[0]?.text === "pr" && ["create", "edit", "merge"].includes(rest[1]?.text ?? "")) {
      problems.push(...checkGhPr(rest[1]?.text as string, rest.slice(2)));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Entry points

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function parseIdent(ident: string): { name: string; email: string } {
  const match = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(ident);
  return { name: match?.[1] ?? "", email: match?.[2] ?? "" };
}

function commitMsg(file: string): number {
  const problems = [...checkCommitMessage(readFileSync(file, "utf8"))];
  for (const role of ["author", "committer"] as const) {
    const ident = parseIdent(git(["var", role === "author" ? "GIT_AUTHOR_IDENT" : "GIT_COMMITTER_IDENT"]));
    problems.push(...checkIdentity(role, ident.name, ident.email));
  }
  if (problems.length > 0) {
    console.error(`commit rejected (blueprinter-kit release rules):\n- ${problems.join("\n- ")}`);
    return 1;
  }
  return 0;
}

function claudeHook(): number {
  let input: { tool_name?: string; cwd?: string; tool_input?: { command?: string } };
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string") return 0;
  const read = (key: string) => {
    try {
      return git(["config", key], input.cwd);
    } catch {
      return "";
    }
  };
  const problems = checkShellCommand(command, { repoIdentity: { name: read("user.name"), email: read("user.email") }, env: process.env });
  if (problems.length === 0) return 0;
  console.error(
    `Blocked by blueprinter-kit release rules. Every commit and pull request here is a release:\n- ${problems.join("\n- ")}\n` +
      `Commit with: git -c user.name=${OWNER.name} -c user.email=${OWNER.email} commit -m vX.Y.Z\n` +
      `Open pull requests with: gh pr create --title vX.Y.Z --body ""`,
  );
  return 2;
}

interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

function commitsIn(range: string[]): Commit[] {
  const out = git(["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e", ...range]);
  return out
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [sha = "", authorName = "", authorEmail = "", committerName = "", committerEmail = "", message = ""] = entry.split("\x00");
      return { sha, authorName, authorEmail, committerName, committerEmail, message };
    });
}

function ci(): number {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const name = process.env.GITHUB_EVENT_NAME;
  const problems: string[] = [];
  const pkgVersion = `v${JSON.parse(readFileSync("package.json", "utf8")).version}`;
  let commits: Commit[];
  let allowWebFlow = false;

  if (name === "pull_request") {
    const pr = event.pull_request;
    problems.push(...checkPullRequest({ title: pr.title, body: pr.body }));
    if (pr.title !== pkgVersion) problems.push(`package.json says ${pkgVersion}, the title ${pr.title}`);
    const tags = git(["tag", "--list", "v*"]).split("\n").filter(isReleaseVersion);
    const latest = tags.sort(compareVersions).at(-1);
    if (latest && compareVersions(pkgVersion, latest) <= 0) problems.push(`${pkgVersion} must be greater than the latest release ${latest}`);
    commits = commitsIn([`${pr.base.sha}..${pr.head.sha}`]);
  } else if (name === "push") {
    allowWebFlow = true;
    // Every commit on main must be a release, and a forced push leaves `before` unknown,
    // so check the whole history (one commit per release).
    commits = commitsIn([String(event.after)]);
    const head = commits[0];
    if (head && head.message.trim() !== pkgVersion) problems.push(`package.json says ${pkgVersion}, the head commit ${JSON.stringify(head.message.trim())}`);
  } else {
    console.log(`release rules: nothing to check for ${name}`);
    return 0;
  }

  for (const c of commits) {
    const own = [
      ...checkCommitMessage(c.message),
      ...checkIdentity("author", c.authorName, c.authorEmail),
      ...checkIdentity("committer", c.committerName, c.committerEmail, { allowWebFlow }),
    ];
    problems.push(...own.map((p) => `${c.sha.slice(0, 12)}: ${p}`));
  }
  if (problems.length > 0) {
    console.error(`release rules failed:\n- ${problems.join("\n- ")}`);
    return 1;
  }
  console.log(`release rules ok: ${commits.length} commit(s), version ${pkgVersion}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, arg] = process.argv.slice(2);
  process.exitCode =
    mode === "commit-msg" && arg ? commitMsg(arg) : mode === "claude-hook" ? claudeHook() : mode === "ci" ? ci() : (console.error("usage: release-rules.ts commit-msg <file> | claude-hook | ci"), 2);
}
