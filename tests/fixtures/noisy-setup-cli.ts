// A setup CLI whose handler prints to stdout in every way it can; serve must keep stdout clean.
import { defineSetupCli, serve } from "../../src/setup-cli.ts";

await serve(
  defineSetupCli({
    id: "noisy",
    checks: [
      {
        id: "noisy.a",
        scope: "tenant",
        title: "Noisy",
        access: "public",
        humanOnly: true,
        probe: () => {
          console.log("console.log line");
          console.info("console.info line");
          process.stdout.write("stdout.write line\n");
          return { state: "ok", detail: "quiet" };
        },
      },
    ],
  }),
);
