import { runCli } from "../../../src/cli/run.ts";

await runCli({ argv: Bun.argv.slice(2), rootUrl: import.meta.url });
