import "./observed-worker-preload";
import { installEngineComposition } from "@lando/engine/composition";
import { runCli } from "../../../src/cli/run";

const eventsIndex = process.argv.indexOf("--test-events");
if (eventsIndex >= 0) process.env.LANDO_TEST_HOST_PROXY_EVENTS = process.argv[eventsIndex + 1];
const inputs = globalThis.__landoEngineCompositionInputs;
if (inputs === undefined) throw new TypeError("Missing test composition");
installEngineComposition({
  ...inputs,
  hostProxyWorkerEntry: () => ({
    execPath: process.execPath,
    entryPath: undefined,
    bunSourceEntryPath: import.meta.path,
  }),
});
await runCli({ argv: process.argv.slice(2), rootUrl: import.meta.url });
