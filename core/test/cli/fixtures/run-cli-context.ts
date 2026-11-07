import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect } from "effect";
import { runCli } from "../../../src/cli/index.ts";
import { makeScenarioProvider } from "../../../src/testing/scenario-provider.ts";

const cwd = process.argv[2];
if (cwd === undefined) throw new TypeError("Missing invocation directory");
const before = { cwd: process.cwd(), env: { ...process.env }, exitCode: process.exitCode ?? 0 };
const provider = makeScenarioProvider();
const outputs = [];
const observedDirectories: string[] = [];
for (const argv of [
  ["version", "--format=json"],
  ["start", "--format=json"],
  ["not-a-command", "--format=json"],
  [
    "meta:bun",
    "-e",
    "console.log(process.cwd()); console.log(process.env.LANDO_INVOCATION_VALUE); console.log(await Bun.stdin.text())",
  ],
  ["meta:mcp"],
]) {
  const io = createBufferedRendererIO({ stdin: "host input" });
  const statuses: number[] = [];
  const controller = new AbortController();
  await runCli({
    argv,
    rootUrl: "",
    signal: controller.signal,
    context: {
      cwd,
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: `${cwd}/host/data`,
        LANDO_USER_CONF_ROOT: `${cwd}/host/config`,
        LANDO_USER_CACHE_ROOT: `${cwd}/host/cache`,
        LANDO_SYSTEM_PLUGIN_ROOT: `${cwd}/host/plugins`,
        LANDO_PROVIDER: "test",
        LANDO_INVOCATION_VALUE: "context-only",
        ...(argv[0] === "meta:mcp" ? { LANDO_CONFIG__ROUTER__HTTP_PORT: "invalid" } : {}),
      },
      io,
      setExitCode: (code) => {
        statuses.push(code);
        if (argv[0] === "meta:mcp" && code !== 0) controller.abort("SIGINT");
      },
      providerRegistry: provider.layer,
      serviceLayers: [provider.hostServices],
      observeEvent: () => {
        observedDirectories.push(process.cwd());
      },
    },
  });
  outputs.push({ stdout: io.stdout(), stderr: io.stderr(), statuses });
}
const after = { cwd: process.cwd(), env: { ...process.env }, exitCode: process.exitCode ?? 0 };
const plans = await Effect.runPromise(provider.appliedPlans);
await Bun.write(
  Bun.stdout,
  JSON.stringify({
    outputs,
    untouched: JSON.stringify(before) === JSON.stringify(after),
    cwd: before.cwd,
    observedDirectories,
    apps: plans.map((plan) => plan.id),
  }),
);
