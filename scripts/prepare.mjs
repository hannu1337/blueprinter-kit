// Runs on `npm install` / `pnpm install`, also when this package is installed
// as a git dependency: builds dist/ and, in a clone of this repository, points
// git at the committed hooks.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit", shell: process.platform === "win32" });

if (existsSync(".git") && existsSync(".githooks/commit-msg")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    // not a usable git checkout (for example a package manager's temporary clone)
  }
}
