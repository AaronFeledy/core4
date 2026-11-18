import { expect, test } from "bun:test";
import { withScenarioContext } from "@lando/core/testing";
import { GlobalStatusResultSchema } from "@lando/engine/operations/global-status";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope));

test("global:destroy without --yes preserves the running global app in non-interactive mode", async () => {
  await Effect.runPromise(
    withScenarioContext(
      { guideId: "global-destroy-cli", scenarioId: "confirmation", render: false },
      (context) =>
        Effect.gen(function* () {
          const started = yield* context.runCli(["global:start", "--format=json"]);
          expect(started.exitCode, started.stdout + started.stderr).toBe(0);
          const runningServices = context.runCli(["global:status", "--format=json"]).pipe(
            Effect.map((run) => {
              expect(run.exitCode, run.stdout + run.stderr).toBe(0);
              return Schema.decodeUnknownSync(GlobalStatusResultSchema)(decodeEnvelope(run.stdout).result)
                .services.filter((service) => service.status === "running")
                .map((service) => service.service)
                .sort();
            }),
          );
          const before = yield* runningServices;
          expect(before).toContain("traefik");

          const run = yield* context.runCli(["global:destroy", "--format=json"]);

          expect(run.exitCode).not.toBe(0);
          expect(decodeEnvelope(run.stdout)).toMatchObject({
            ok: false,
            error: {
              _tag: "CommandConfirmationError",
              reason: "non-interactive",
              remediation: expect.stringContaining("--yes"),
            },
          });
          expect(yield* runningServices).toEqual(before);
        }),
    ),
  );
}, 30_000);
