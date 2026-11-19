import { expect, test } from "bun:test";
import { withScenarioContext } from "@lando/core/testing";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { ScratchStartResultSchema } from "../../src/cli/commands/scratch.ts";

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(StreamFrame));
const decodeFrames = (stdout: string) =>
  stdout
    .trimEnd()
    .split("\n")
    .map((line) => decodeFrame(line));

test("scratch:logs emits provider chunks followed by one terminal result frame", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "scratch-logs-frames", render: false }, (context) =>
      Effect.gen(function* () {
        yield* context.fixtures.use("exec-demo");
        const started = yield* context.runCli(["scratch:start", "--fork", "--detach", "--format=json"]);
        expect(started.exitCode, started.stdout + started.stderr).toBe(0);
        const start = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope))(started.stdout);
        const {
          handle: { id },
        } = Schema.decodeUnknownSync(ScratchStartResultSchema)(start.result);

        const run = yield* context.runCli(["scratch:logs", id, "--format=json"]);

        expect(run.exitCode, run.stdout + run.stderr).toBe(0);
        const frames = decodeFrames(run.stdout);
        expect(frames.slice(0, -1).filter((frame) => frame._tag !== "event")).toEqual([
          { _tag: "stdout", service: "app", chunk: "ready\n" },
        ]);
        expect(frames.at(-1)).toMatchObject({
          _tag: "result",
          envelope: { command: "apps:scratch:logs", ok: true, result: { app: id } },
        });
      }),
    ),
  );
}, 30_000);

test("scratch:logs encodes an unknown id as a terminal error envelope", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "scratch-logs-cli", scenarioId: "missing-id", render: false }, (context) =>
      Effect.gen(function* () {
        const run = yield* context.runCli(["scratch:logs", "scratch-missing-abc123", "--format=json"]);

        expect(run.exitCode).not.toBe(0);
        const frames = decodeFrames(run.stdout);
        expect(frames.slice(0, -1).every((frame) => frame._tag === "event")).toBe(true);
        expect(frames.at(-1)).toMatchObject({
          _tag: "result",
          envelope: {
            ok: false,
            error: { _tag: "ScratchAppNotFoundError", remediation: expect.stringMatching(/\S/u) },
          },
        });
      }),
    ),
  );
}, 30_000);
