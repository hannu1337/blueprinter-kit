#!/usr/bin/env node
/**
 * blueprinter-kit conformance [dir] [--entry <command>] [--timeout <seconds>] [--json]
 */
import { parseArgs } from "node:util";
import { formatReport, runConformance } from "./conformance.ts";

const USAGE = `usage: blueprinter-kit conformance [dir] [--entry <command>] [--timeout <seconds>] [--json]

Checks the service repository in dir (default: .) against the setup-CLI contract:
the recipe schema, describe with closed stdin and a timeout, the check-id
namespace, dependsOn, human-only and fix consistency, no-access probes, error
envelopes, teardown and the overlay paths. --entry runs any setup CLI instead
of the recipe's setupCli.entry. Exits 0 when conformant, 1 when not, 2 on bad usage.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command !== "conformance") {
    console.error(USAGE);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { entry: { type: "string" }, timeout: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const timeout = parsed.values.timeout === undefined ? undefined : Number(parsed.values.timeout);
  if (parsed.positionals.length > 1 || (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))) {
    console.error(USAGE);
    return 2;
  }
  const report = await runConformance({
    dir: parsed.positionals[0] ?? ".",
    ...(parsed.values.entry === undefined ? {} : { entry: parsed.values.entry }),
    ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
  });
  console.log(parsed.values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
