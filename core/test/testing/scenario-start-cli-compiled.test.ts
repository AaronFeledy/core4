import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ScenarioContextFactory } from "@lando/core/testing";
import { Effect, Schema } from "effect";
import { ensureCompiledCli } from "../_support/compiled-cli";
import { withEnvVar } from "../_support/temp-cwd";
import { stubContainerHelperDir } from "../build/fixtures/container-helper-stubs";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

test("exchanges MCP frames through the relocated compiled CLI", async () => {
  const helpers = await stubContainerHelperDir();
  try {
    const binary = await withEnvVar("LANDO_CONTAINER_HELPER_DIR", helpers, ensureCompiledCli);
    await Effect.runPromise(
      ScenarioContextFactory.e2e(
        {
          guideId: "background-cli",
          scenarioId: "compiled",
          render: false,
          e2eEnv: { ...process.env, LANDO_SCENARIO_E2E_BINARY: binary },
        },
        (context) =>
          Effect.gen(function* () {
            const child = yield* context.startCli("mcp", { stdin: "pipe" });
            yield* child.write(
              '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"compiled-test","version":"1"}}}\n',
            );
            const reply = yield* child.stdoutLine((line) => decode(line).id === 1);
            expect(decode(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: "lando" } } });
            yield* child.closeInput;
            expect(yield* child.result).toMatchObject({ exitCode: 0, stderr: "", events: [] });
          }),
      ),
    );
  } finally {
    await rm(helpers, { recursive: true, force: true });
  }
}, 240_000);

test.each([
  ["absent", "missing-binary"],
  ["not executable", "spawn-failed"],
] as const)("reports when the configured compiled CLI is %s", async (condition, reason) => {
  await Effect.runPromise(
    ScenarioContextFactory.scenario(
      {
        guideId: "background-cli",
        scenarioId: reason,
        render: false,
      },
      (outer) =>
        Effect.gen(function* () {
          const binary = join(outer.testDir, "lando");
          if (condition === "not executable")
            yield* Effect.promise(() => Bun.write(binary, "not an executable"));
          yield* ScenarioContextFactory.e2e(
            {
              guideId: "background-cli",
              scenarioId: `${reason}-child`,
              render: false,
              e2eEnv: { LANDO_SCENARIO_E2E_BINARY: binary },
            },
            (context) =>
              Effect.gen(function* () {
                const failure = yield* Effect.flip(context.startCli("mcp"));
                expect(failure.reason).toBe(reason);
              }),
          );
        }),
    ),
  );
});
