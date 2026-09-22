import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  OWNER,
  checkCommitMessage,
  checkIdentity,
  checkPullRequest,
  checkShellCommand,
  compareVersions,
} from "../scripts/release-rules.ts";

const script = fileURLToPath(new URL("../scripts/release-rules.ts", import.meta.url));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const OWNER_ARGS = ["-c", `user.name=${OWNER.name}`, "-c", `user.email=${OWNER.email}`];

describe("commit messages", () => {
  it("accepts exactly vX.Y.Z", () => {
    for (const ok of ["v1.0.0", "v1.0.0\n", "v0.10.2\n\n", "v12.3.45", "v1.0.0\n# Please enter the commit message\n#\n"]) {
      assert.deepEqual(checkCommitMessage(ok), [], JSON.stringify(ok));
    }
  });
  it("rejects anything else, including bodies and trailers", () => {
    for (const bad of ["", "1.0.0", "v1.0", "v01.0.0", "v1.0.0-rc.1", "release v1.0.0", "v1.0.0 ", " v1.0.0", "v1.0.0\n\nbody", "v1.0.0\n\nCo-Authored-By: someone <a@b.c>", "V1.0.0"]) {
      assert.notDeepEqual(checkCommitMessage(bad), [], JSON.stringify(bad));
    }
  });
});

describe("identities", () => {
  it("accepts only the owner's noreply identity", () => {
    assert.deepEqual(checkIdentity("author", OWNER.name, OWNER.email), []);
    assert.notDeepEqual(checkIdentity("author", OWNER.name, "someone@example.com"), []);
    assert.notDeepEqual(checkIdentity("author", "Real Name", OWNER.email), []);
  });
  it("accepts GitHub's web-flow committer only where squash merges happen", () => {
    assert.notDeepEqual(checkIdentity("committer", "GitHub", "noreply@github.com"), []);
    assert.deepEqual(checkIdentity("committer", "GitHub", "noreply@github.com", { allowWebFlow: true }), []);
    assert.notDeepEqual(checkIdentity("author", "GitHub", "noreply@github.com", { allowWebFlow: true }), []);
  });
});

describe("pull requests", () => {
  it("need a vX.Y.Z title and an empty body", () => {
    assert.deepEqual(checkPullRequest({ title: "v1.2.3", body: "" }), []);
    assert.deepEqual(checkPullRequest({ title: "v1.2.3", body: null }), []);
    assert.notDeepEqual(checkPullRequest({ title: "v1.2.3", body: "because" }), []);
    assert.notDeepEqual(checkPullRequest({ title: "Add a thing", body: "" }), []);
  });
  it("compare versions numerically", () => {
    assert.ok(compareVersions("v1.10.0", "v1.9.9") > 0);
    assert.ok(compareVersions("v1.0.0", "v1.0.0") === 0);
    assert.ok(compareVersions("v0.9.0", "v1.0.0") < 0);
  });
});

describe("shell commands seen by the Claude Code hook", () => {
  const repo: { name: string; email: string } = { name: OWNER.name, email: OWNER.email };
  const check = (command: string, identity = repo) => checkShellCommand(command, { repoIdentity: identity, env: {} });

  it("lets through commands that do not commit or open pull requests", () => {
    for (const command of ["ls -la", "git status", "git log --oneline", "npm test", "echo 'git commit -m x'", "gh pr view 3", "gh pr list"]) {
      assert.deepEqual(check(command), [], command);
    }
  });

  it("allows a release commit with the owner identity", () => {
    for (const command of [
      'git commit -m "v1.0.1"',
      "git commit -am v1.0.1",
      "git commit --message=v1.0.1",
      "cd /x && git add -A && git commit -m 'v1.0.1'",
      `git -c user.name=${OWNER.name} -c user.email=${OWNER.email} commit -m v1.0.1`,
      `git commit --author="${OWNER.name} <${OWNER.email}>" -m v1.0.1`,
      "git commit --amend --no-edit",
    ]) {
      assert.deepEqual(check(command), [], command);
    }
  });

  it("blocks commits with another message", () => {
    for (const command of [
      'git commit -m "fix: things"',
      'git commit -m v1.0.1 -m "body"',
      'git commit -m "v1.0.1\n\nCo-Authored-By: x"',
      'git commit -m "$(cat msg.txt)"',
      "git commit -m `cat msg`",
      "git commit -F msg.txt",
      "git commit -m v1.0.1 --trailer 'Co-authored-by: x'",
      "git commit -s -m v1.0.1",
      "git commit --fixup HEAD",
      "git commit -C HEAD~1",
      "git commit --no-verify -m v1.0.1",
      "git commit -nm v1.0.1",
    ]) {
      assert.notDeepEqual(check(command), [], command);
    }
  });

  it("blocks commits with another identity", () => {
    assert.notDeepEqual(check("git commit -m v1.0.1", { name: "Real Name", email: "me@example.com" }), []);
    assert.notDeepEqual(check('git commit --author="Real Name <me@example.com>" -m v1.0.1'), []);
    assert.notDeepEqual(check("git -c user.email=me@example.com commit -m v1.0.1"), []);
    assert.notDeepEqual(check("GIT_AUTHOR_EMAIL=me@example.com git commit -m v1.0.1"), []);
    assert.notDeepEqual(check("GIT_COMMITTER_NAME='Real Name' git commit -m v1.0.1"), []);
    assert.notDeepEqual(checkShellCommand("git commit -m v1.0.1", { repoIdentity: repo, env: { GIT_AUTHOR_EMAIL: "me@example.com" } }), []);
  });

  it("allows only release pull requests", () => {
    assert.deepEqual(check('gh pr create --title v1.0.1 --body ""'), []);
    assert.deepEqual(check("gh pr create -t v1.0.1 -b ''"), []);
    assert.deepEqual(check("gh pr edit 4 --title v1.0.2"), []);
    assert.deepEqual(check("gh pr merge 4 --squash"), []);
    for (const command of [
      "gh pr create --fill",
      'gh pr create --title "Add a thing" --body ""',
      'gh pr create --title v1.0.1 --body "why"',
      "gh pr create --title v1.0.1",
      "gh pr create --title v1.0.1 --body-file notes.md",
      "gh pr create --title v1.0.1 --body '' --web",
      "gh pr edit 4 --body 'context'",
      "gh pr merge 4 --merge",
      "gh pr merge 4 --rebase",
      "gh pr merge 4 --squash --subject 'nice'",
      "gh pr merge 4 --squash --body 'x'",
    ]) {
      assert.notDeepEqual(check(command), [], command);
    }
  });
});

describe("the committed hooks", () => {
  function scratchRepo() {
    const dir = mkdtempSync(join(tmpdir(), "kit-hook-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "config", "core.hooksPath", fileURLToPath(new URL("../.githooks", import.meta.url))]);
    writeFileSync(join(dir, "f"), "x");
    execFileSync("git", ["-C", dir, "add", "f"]);
    return dir;
  }
  const commit = (dir: string, identity: string[], message: string) =>
    spawnSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...identity, "commit", "-q", "-m", message], { encoding: "utf8", env: cleanEnv });

  it("commit-msg rejects a bad message and a bad author, and accepts a release", () => {
    const dir = scratchRepo();
    try {
      const badMessage = commit(dir, OWNER_ARGS, "wip");
      assert.notEqual(badMessage.status, 0);
      assert.match(badMessage.stderr, /vX\.Y\.Z/);
      const badAuthor = commit(dir, ["-c", "user.name=Someone", "-c", "user.email=someone@example.com"], "v1.0.0");
      assert.notEqual(badAuthor.status, 0);
      assert.match(badAuthor.stderr, /noreply/);
      const good = commit(dir, OWNER_ARGS, "v1.0.0");
      assert.equal(good.status, 0, good.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Claude Code hook exits 2 on a bad commit and 0 otherwise", () => {
    const run = (command: string) =>
      spawnSync(process.execPath, [script, "claude-hook"], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: fileURLToPath(new URL("..", import.meta.url)), tool_input: { command } }),
        encoding: "utf8",
        env: cleanEnv,
      });
    const bad = run('git commit -m "feat: add"');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /vX\.Y\.Z/);
    assert.equal(run("git status").status, 0);
    const other = spawnSync(process.execPath, [script, "claude-hook"], { input: JSON.stringify({ tool_name: "Read", tool_input: {} }), encoding: "utf8" });
    assert.equal(other.status, 0);
  });
});
