// A setup CLI written without the kit, to show that conformance takes any entry.
// It is conformant by default; each violation fixture switches on one fault.
import { readFileSync } from "node:fs";

export function run(faults = {}) {
  const id = faults.id ?? "raw";
  const checks = faults.checks ?? [
    { id: `${id}.tenant`, scope: "tenant", title: "Tenant", dependsOn: ["deploy.staging"], access: "service-token", humanOnly: false },
    { id: `${id}.tenant.manual`, scope: "tenant", title: "Manual step", dependsOn: [`${id}.tenant`], access: "public", humanOnly: true },
  ];
  const [command, checkId] = process.argv.slice(2);
  const reply = (envelope) => {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = envelope.ok ? 0 : 1;
  };
  const error = (code, message) => reply({ ok: false, error: { code, message } });

  if (command === "describe") {
    if (faults.describeNeedsStdin) JSON.parse(readFileSync(0, "utf8")); // fails when stdin is closed
    if (faults.describeHangs) setInterval(() => {}, 1000);
    if (faults.stdoutNoise) console.log("starting up");
    if (faults.describeHangs) return;
    return reply({ ok: true, result: { protocolVersion: 1, id, inputs: [], checks } });
  }
  if (!["probe", "plan", "fix", "teardown"].includes(command)) {
    return faults.noErrorEnvelope ? void (process.exitCode = 1) : error("unknown-command", `unknown command ${command}`);
  }
  const request = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (request.protocolVersion !== undefined && request.protocolVersion !== 1) return error("unsupported-protocol", "protocolVersion 1 only");
  if (command === "teardown") {
    if (faults.teardownFails) return error("internal", "cannot revoke");
    return reply({ ok: true, result: { revoked: [] } });
  }
  const check = checks.find((c) => c.id === checkId);
  if (!check) return error("unknown-check", `no check ${checkId}`);
  const token = request.credentials?.serviceBootstrapToken;
  if (command === "probe") {
    if (!token && check.access === "service-token" && !faults.probeIgnoresToken) {
      return reply({ ok: true, result: { state: "no-access" } });
    }
    return reply({ ok: true, result: { state: "missing" } });
  }
  if (check.humanOnly && !faults.humanOnlyFixable) return error("not-fixable", `${check.id} is human-only`);
  if (!check.humanOnly && faults.fixMissing) return error("not-fixable", `${check.id} has no fix`);
  if (!token) return error("no-credential", "needs the service bootstrap token");
  return reply({ ok: true, result: command === "plan" ? { summary: "change" } : { outputs: {} } });
}
