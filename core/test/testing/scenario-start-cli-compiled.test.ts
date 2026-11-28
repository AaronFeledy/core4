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

test("drains both child pipes without retaining more than the capture budget per stream", async () => {
  const payload = `const chunk = "x".repeat(1024 * 1024);
for (let i = 0; i < 9; i++) { console.log(chunk); console.error(chunk); }`;
  await Effect.runPromise(
    ScenarioContextFactory.e2e(
      {
        guideId: "background-cli",
        scenarioId: "bounded-output",
        render: false,
        e2eEnv: { ...process.env, LANDO_SCENARIO_E2E_BINARY: process.execPath },
      },
      (context) =>
        Effect.gen(function* () {
          const child = yield* context.hidden(context.startCli(["-e", payload]));
          const { stdout, stderr, exitCode } = yield* child.result;
          const suffix = "\n[scenario output truncated]\n";
          expect(exitCode).toBe(0);
          for (const output of [stdout, stderr]) {
            expect(output.endsWith(suffix)).toBe(true);
            expect(Buffer.byteLength(output.slice(0, -suffix.length))).toBe(8 * 1024 * 1024);
          }
          expect((yield* Effect.flip(child.stdoutLine((line) => line === "absent"))).reason).toBe(
            "output-limit",
          );
        }),
    ),
  );
});
