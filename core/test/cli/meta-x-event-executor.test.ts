import { describe, expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { CommandInputValidationError } from "@lando/sdk/errors";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import {
  EventService,
  type EventServiceShape,
  type LandoEvent,
  ProcessRunner,
  type ProcessSpawnOptions,
  Renderer,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect, Queue, Stream } from "effect";

import type { BuiltInCommandEntry } from "../../src/cli/built-in-command-registry.ts";
import { metaXSpec } from "../../src/cli/command-specs/meta/x.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { processRunnerFor } from "../_support/process-runner.ts";

const makeHarness = () => {
  const events: LandoEvent[] = [];
  const eventService: EventServiceShape = {
    publish: (event) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeWithHistory: () => Effect.never,
    subscribeQueue: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return queue;
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  };
  const renderer = {
    id: "plain",
    capabilities: RENDERER_CAPABILITIES_NONE,
    message: {
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
    },
    output: {
      stdout: () => Effect.void,
      stderr: () => Effect.void,
    },
  } satisfies Context.Service.Shape<typeof Renderer>;
  return {
    events,
    context: Context.make(Context.Service<unknown>("test/runtime"), {}).pipe(
      Context.add(EventService, eventService),
      Context.add(Renderer, renderer),
      Context.add(RedactionService, makeRedactionService()),
      Context.add(PrivateFileAccessService, ownerOnlyFileAccess),
    ),
  };
};

const entryFor = (spec: typeof metaXSpec): BuiltInCommandEntry => ({
  spec: {
    ...spec,
    flags: spec.flags ?? {},
    args: spec.args ?? {},
  },
  status: { kind: "implemented" },
});

describe("meta:x event executor", () => {
  test("preserves structured args and returns nonzero without mutating host exitCode", async () => {
    // Given
    const harness = makeHarness();
    const requests: ProcessSpawnOptions[] = [];
    const runner = processRunnerFor((input) =>
      Effect.sync(() => {
        requests.push(input);
        return { exitCode: 9 };
      }),
    );
    const priorExitCode = process.exitCode;
    process.exitCode = 92;
    const executor = makeEventCommandExecutor(Context.add(harness.context, ProcessRunner, runner), [
      entryFor(metaXSpec),
    ]);
    try {
      // When
      const result = await Effect.runPromise(
        executor.run({
          command: "meta:x",
          flags: {},
          args: { spec: "example-package" },
          argv: ["--example-flag"],
          cwd: process.cwd(),
          silent: true,
        }),
      );
      // Then
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        cmd: process.execPath,
        args: ["x", "example-package", "--example-flag"],
        capture: true,
      });
      expect(requests[0]?.inheritStdin).toBeUndefined();
      expect(requests[0]?.inheritOutput).toBeUndefined();
      expect(result.exitCode).toBe(9);
      expect(process.exitCode).toBe(92);
    } finally {
      process.exitCode = priorExitCode ?? 0;
    }
  });

  test("missing required spec is CommandInputValidationError on validate and run", async () => {
    // Given
    const harness = makeHarness();
    const executor = makeEventCommandExecutor(harness.context, [entryFor(metaXSpec)]);
    const input = {
      command: "meta:x",
      flags: {},
      args: {},
      argv: [],
      cwd: process.cwd(),
      silent: true,
    };
    // When
    const validationError = await Effect.runPromise(Effect.flip(executor.validate?.(input) ?? Effect.void));
    const runError = await Effect.runPromise(Effect.flip(executor.run(input)));
    // Then
    expect(validationError).toBeInstanceOf(CommandInputValidationError);
    expect(validationError).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "meta:x",
      field: "spec",
      kind: "arg",
      reason: "required",
    });
    expect(runError).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "meta:x",
      field: "spec",
      kind: "arg",
      reason: "required",
    });
  });
});
