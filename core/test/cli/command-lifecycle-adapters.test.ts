import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";

import { runDynamicTooling } from "../../src/cli/cli-adapters/app-lifecycle.ts";
import { resolveCanonicalCommandId, runMetaVersion } from "../../src/cli/cli-adapters/meta-plugin.ts";
import { landoSpecForId } from "../../src/cli/compiled-argv.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import * as compiledRuntime from "../../src/cli/compiled-runtime.ts";
import {
  activeCommandId,
  beginNestedCommandInvocation,
  getActiveCommandInvocation,
  resetActiveCommandInvocation,
  setActiveCommandId,
} from "../../src/cli/compiled-runtime.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

afterEach(() => {
  setActiveCommandId("cli:unknown");
  resetActiveCommandInvocation("cli:unknown", []);
});

describe("CLI lifecycle adapters", () => {
  test("meta version replaces stale invocation identity when called directly", async () => {
    // Given
    const runCompiledCommand = spyOn(compiledRuntime, "runCompiledCommand").mockResolvedValue();
    setActiveCommandId("--version");
    resetActiveCommandInvocation("--version", ["stale"]);

    // When
    try {
      await runMetaVersion();
    } finally {
      runCompiledCommand.mockRestore();
    }

    // Then
    expect(activeCommandId).toBe("meta:version");
    const invocation = getActiveCommandInvocation();
    expect(invocation).toMatchObject({
      commandId: "meta:version",
      argv: [],
    });
    expect(typeof invocation?.invocationId).toBe("string");
    expect(invocation?.invocationId?.length).toBeGreaterThan(0);
    expect(invocation?.parentInvocationId).toBeUndefined();
  });

  test("dynamic tooling replaces stale invocation identity and retains arguments", async () => {
    // Given
    const runCompiledCommand = spyOn(compiledRuntime, "runCompiledCommand").mockResolvedValue();
    setActiveCommandId("stale:command");
    resetActiveCommandInvocation("stale:command", ["stale"]);

    // When
    try {
      await runDynamicTooling(["missing-lifecycle-test-tool", "--verbose", "target"]);
    } finally {
      runCompiledCommand.mockRestore();
    }

    // Then
    expect(activeCommandId).toBe("app:missing-lifecycle-test-tool");
    expect(getActiveCommandInvocation()).toMatchObject({
      commandId: "app:missing-lifecycle-test-tool",
      argv: ["--verbose", "target"],
    });
  });

  test("compiled alias input retains the canonical command identity", () => {
    // Given
    const commandId = resolveCanonicalCommandId("start");
    setActiveCommandId(commandId);
    resetActiveCommandInvocation(commandId, []);

    // When
    const input = compiledCommandInputFromArgv(commandId, []);

    // Then
    expect(input.args).toEqual({});
    expect(getActiveCommandInvocation()).toMatchObject({
      commandId: "app:start",
      argv: [],
      args: {},
    });
  });

  test("nested command invocation carries outer id as parent", () => {
    resetActiveCommandInvocation("app:start", ["--yes"]);
    const outer = getActiveCommandInvocation();
    expect(outer?.invocationId).toBeDefined();
    const nested = beginNestedCommandInvocation("app:rebuild", []);
    expect(nested.commandId).toBe("app:rebuild");
    expect(nested.invocationId).toBeDefined();
    expect(nested.invocationId).not.toBe(outer?.invocationId);
    expect(nested.parentInvocationId).toBe(outer?.invocationId);
  });

  test("representative command specs retain every lifecycle bootstrap depth", () => {
    // Given / When
    const declarations = [
      ["meta:version", landoSpecForId("meta:version")?.bootstrap],
      ["meta:update", landoSpecForId("meta:update")?.bootstrap],
      ["meta:doctor", landoSpecForId("meta:doctor")?.bootstrap],
      ["app:start", landoSpecForId("app:start")?.bootstrap],
    ];

    // Then
    expect(declarations).toEqual([
      ["meta:version", "none"],
      ["meta:update", "plugins"],
      ["meta:doctor", "provider"],
      ["app:start", "app"],
    ]);
  });

  test("every result-driven nonzero exit declares its lifecycle exit-code policy", () => {
    const ids = [
      "app:config:lint",
      "app:includes:update",
      "app:includes:verify",
      "app:exec",
      "app:ssh",
      "app:shell",
      "meta:plugin:build",
      "meta:plugin:publish",
      "meta:plugin:test",
      "meta:uninstall",
    ];

    expect(ids.filter((id) => landoSpecForId(id)?.successExitCode === undefined)).toEqual([]);
  });

  test("result-driven plugin commands publish and apply their nonzero lifecycle exit code", async () => {
    const ids = ["meta:plugin:build", "meta:plugin:publish", "meta:plugin:test"];

    for (const id of ids) {
      // Given
      const events: LandoEvent[] = [];
      const exitCodes: number[] = [];
      const eventService: EventServiceShape = {
        publish: (event) => Effect.sync(() => events.push(event)),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.gen(function* () {
          return yield* Queue.unbounded<LandoEvent>();
        }),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      };
      const spec = landoSpecForId(id);
      if (spec?.successExitCode === undefined) throw new Error(`${id} lacks successExitCode`);

      // When
      await runWithRendererHandling(Effect.succeed({ exitCode: 17 }), {
        runtime: Layer.succeed(EventService, eventService),
        rendererMode: "plain",
        command: id,
        invocation: { commandId: id, argv: [], args: {}, flags: {}, cwd: "/workspace/plugin" },
        resultSchema: spec.resultSchema,
        io: createBufferedRendererIO(),
        render: () => undefined,
        successExitCode: spec.successExitCode,
        setExitCode: (code) => exitCodes.push(code),
        formatError: (error) => String(error),
      });

      // Then
      expect(events.at(-1)).toMatchObject({ _tag: `cli-${id}-run`, exitCode: 17 });
      expect(exitCodes).toEqual([17]);
    }
  });
});
