import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { type ScenarioContext, withScenarioContext } from "@lando/core/testing";
import { PoweroffResultSchema, PoweroffStopError } from "@lando/engine/operations/poweroff";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope));
const decodeResult = Schema.decodeUnknownSync(PoweroffResultSchema);

const startWithHook = (
  context: ScenarioContext,
  appId: string,
  hook: { readonly event: "pre-stop" | "post-stop"; readonly cmd: string },
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      Bun.write(
        join(context.testDir, ".lando.yml"),
        [
          `name: ${appId}`,
          "services:",
          "  app:",
          '    type: "node:22"',
          "    primary: true",
          "events:",
          `  ${hook.event}:`,
          `    - cmd: ${JSON.stringify(hook.cmd)}`,
          '      service: ":host"',
          "",
        ].join("\n"),
      ),
    );
    const started = yield* context.runCli(["start", "--format=json"]);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
  });

test("poweroff runs a running app's post-stop host hook", async () => {
  await Effect.runPromise(
    withScenarioContext(
      { guideId: "poweroff-cli-boundary", scenarioId: "post-stop", render: false },
      (context) =>
        Effect.gen(function* () {
          const appId = "poweroff-app-a";
          const marker = join(context.testDir, "a-hook");
          yield* startWithHook(context, appId, { event: "post-stop", cmd: `touch ${Bun.$.escape(marker)}` });
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false);

          const run = yield* context.runCli(["poweroff", "--format=json"]);

          expect(run.exitCode, run.stdout + run.stderr).toBe(0);
          const envelope = decodeEnvelope(run.stdout);
          expect(envelope.ok).toBe(true);
          expect(decodeResult(envelope.result).apps.find((app) => app.appId === appId)?.outcome).toBe(
            "stopped",
          );
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true);
        }),
    ),
  );
}, 30_000);

test("poweroff omits an already stopped app without rerunning its hook", async () => {
  await Effect.runPromise(
    withScenarioContext(
      { guideId: "poweroff-cli-boundary", scenarioId: "quiescent", render: false },
      (context) =>
        Effect.gen(function* () {
          const appId = "poweroff-app-b";
          const log = Bun.file(join(context.testDir, "b-hook.log"));
          const lineCount = () => Effect.promise(async () => (await log.text()).trimEnd().split("\n").length);
          yield* startWithHook(context, appId, {
            event: "post-stop",
            cmd: `echo stopped >> ${Bun.$.escape(join(context.testDir, "b-hook.log"))}`,
          });
          const stopped = yield* context.runCli(["stop", "--format=json"]);
          expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
          const before = yield* lineCount();
          expect(before).toBe(1);

          const run = yield* context.runCli(["poweroff", "--format=json"]);

          expect(run.exitCode, run.stdout + run.stderr).toBe(0);
          const envelope = decodeEnvelope(run.stdout);
          expect(envelope.ok).toBe(true);
          expect(decodeResult(envelope.result).apps.map((app) => app.appId)).not.toContain(appId);
          expect(yield* lineCount()).toBe(before);
        }),
    ),
  );
}, 30_000);

test("poweroff encodes nested stop failures and reports the global app as skipped", async () => {
  await Effect.runPromise(
    withScenarioContext(
      { guideId: "poweroff-cli-boundary", scenarioId: "pre-stop-failure", render: false },
      (context) =>
        Effect.gen(function* () {
          const appId = "poweroff-app-c";
          const root = yield* Effect.promise(() => realpath(context.testDir));
          yield* startWithHook(context, appId, { event: "pre-stop", cmd: "exit 1" });

          const run = yield* context.runCli(["poweroff", "--format=json"]);

          expect(run.exitCode).not.toBe(0);
          const envelope = decodeEnvelope(run.stdout);
          expect(envelope.ok).toBe(false);
          expect(envelope.error?._tag).toBe("PoweroffStopError");
          const apps = Schema.decodeUnknownSync(PoweroffStopError.fields.apps)(envelope.error?.apps);
          const failures = Schema.decodeUnknownSync(
            Schema.NonEmptyArray(
              Schema.Struct({
                _tag: Schema.NonEmptyString,
                message: Schema.String,
                remediation: Schema.NonEmptyString,
              }),
            ),
          )(envelope.error?.failures);
          for (const failure of failures) {
            expect(failure.message).toContain(appId);
            expect(failure.message).toContain(root);
          }
          expect(apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
        }),
    ),
  );
}, 30_000);
