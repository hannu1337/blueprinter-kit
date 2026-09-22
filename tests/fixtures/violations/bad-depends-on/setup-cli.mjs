import { run } from "../raw-setup-cli.mjs";
run({ checks: [{ id: "raw.tenant", scope: "tenant", title: "Tenant", dependsOn: ["cloudflare.token.staging"], access: "public", humanOnly: true }] });
