import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { EventService, type LandoEvent, ProcessRunner, ShellRunner } from "@lando/sdk/services";
import { Effect, Layer, Queue, Stream } from "effect";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { ToolingBooleanEnvironment } from "../../src/services/tooling-input-environment.ts";
import * as BunShellRunner from "../shell-runner.ts";

const runners = ["process", "shell"] as const;
const shellLayer = BunShellRunner.layer(() => {
  throw new TypeError("unused interactive IO");
});
const eventService = (events: LandoEvent[]) =>
  EventService.of({
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });

for (const runner of runners) {
  test.each([true, false])(
    `${runner} preserves declared boolean %s in events and raw results`,
    async (enabled) => {
      // Given
      const events: LandoEvent[] = [];
      const env = { LANDO_FLAG_TOKEN: String(enabled), LANDO_ARG_PATH: "src" };
      const text = `${enabled}|src|true|false`;
      const args = ["--eval", `process.stdout.write(${JSON.stringify(text)})`];
      const command = `printf '%s' '${text}'`;
      const execute = Effect.gen(function* () {
        return runner === "process"
          ? yield* Effect.flatMap(ProcessRunner, (service) =>
              service.run({ cmd: process.execPath, args, env }),
            )
          : yield* Effect.flatMap(ShellRunner, (service) => service.exec(command, { env }));
      });
      // When
      const result = await Effect.runPromise(
        execute.pipe(
          Effect.provide(Layer.mergeAll(BunProcessRunner.layer, shellLayer)),
          Effect.provideService(ToolingBooleanEnvironment, { LANDO_FLAG_TOKEN: enabled }),
          Effect.provideService(RedactionService, makeRedactionService()),
          Effect.provideService(EventService, eventService(events)),
        ),
      );
      // Then
      expect(result.stdout).toBe(text);
      expect(events).toHaveLength(2);
      expect(events).toMatchObject(
        runner === "process"
          ? [
              { _tag: "pre-process-exec", env, args },
              { _tag: "post-process-exec", env, args, stdout: text },
            ]
          : [
              { _tag: "pre-shell-exec", env, command },
              { _tag: "post-shell-exec", env, command, stdout: text },
            ],
      );
    },
  );

  test.each([true, false])(`${runner} preserves declared boolean %s in failures`, async (enabled) => {
    // Given
    const env = { LANDO_FLAG_TOKEN: String(enabled) };
    const cmd = `missing-${enabled}-canary-executable`;
    const command = `printf '%s' '${enabled}|true|false'; exit 7`;
    const execute = Effect.gen(function* () {
      return runner === "process"
        ? yield* Effect.flatMap(ProcessRunner, (service) => service.run({ cmd, args: [], env }))
        : yield* Effect.flatMap(ShellRunner, (service) => service.exec(command, { env }));
    });
    // When
    const error = await Effect.runPromise(
      execute.pipe(
        Effect.flip,
        Effect.provide(Layer.mergeAll(BunProcessRunner.layer, shellLayer)),
        Effect.provideService(ToolingBooleanEnvironment, { LANDO_FLAG_TOKEN: enabled }),
        Effect.provideService(RedactionService, makeRedactionService()),
      ),
    );
    // Then
    expect(error).toMatchObject(
      runner === "process" ? { cmd } : { stdout: `${enabled}|true|false`, command },
    );
  });

  test.each(["true", "false"])(
    `${runner} masks genuine string secret %s in events and failures`,
    async (secret) => {
      // Given
      const events: LandoEvent[] = [];
      const env = { LANDO_FLAG_TOKEN: secret };
      const execute = Effect.gen(function* () {
        return runner === "process"
          ? yield* Effect.flatMap(ProcessRunner, (service) =>
              service.run({ cmd: `missing-${secret}-canary-executable`, args: [], env }),
            )
          : yield* Effect.flatMap(ShellRunner, (service) =>
              service.exec(`printf '%s' '${secret}'; exit 7`, { env }),
            );
      });
      // When
      const error = await Effect.runPromise(
        execute.pipe(
          Effect.flip,
          Effect.provide(Layer.mergeAll(BunProcessRunner.layer, shellLayer)),
          Effect.provideService(RedactionService, makeRedactionService()),
          Effect.provideService(EventService, eventService(events)),
        ),
      );
      // Then
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ env: { LANDO_FLAG_TOKEN: "[redacted]" } });
      expect(error).toMatchObject(
        runner === "process"
          ? { cmd: "missing-[redacted]-canary-executable" }
          : { stdout: "[redacted]", command: "printf '%s' '[redacted]'; exit 7" },
      );
    },
  );
}
