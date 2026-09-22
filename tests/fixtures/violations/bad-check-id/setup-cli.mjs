import { run } from "../raw-setup-cli.mjs";
run({ checks: [{ id: "other.tenant", scope: "tenant", title: "Tenant", dependsOn: [], access: "public", humanOnly: true }] });
