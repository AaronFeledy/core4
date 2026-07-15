import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { McpToolInputError, McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";

import { mcpRegistryFromCompiled } from "../../src/cli/commands/meta/mcp.ts";
import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { CommandResultOutcome } from "../../src/cli/result-encode.ts";
import { type McpDispatchDeps, type McpProgressFrame, dispatchTool } from "../../src/mcp/dispatch.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import { MAX_OUTBOUND_QUEUED_BYTES } from "../../src/mcp/stdio-limits.ts";

class PromptRequiredError extends Schema.TaggedError<PromptRequiredError>()("RecipeMissingAnswerError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const spec = (
  id: string,
  run: LandoCommandSpec["run"],
  extra: Partial<LandoCommandSpec> = {},
): LandoCommandSpec => ({
  id,
  summary: `${id} summary`,
  namespace: id.split(":")[0] as LandoCommandSpec["namespace"],
  bootstrap: "app",
  resultSchema: EmptyResultSchema,
  run,
  ...extra,
});

const directExecute = (): McpDispatchDeps["execute"] => (entry, runInput) =>
  entry.spec.run(runInput).pipe(
    Effect.map((value) => ({ _tag: "success", value }) satisfies CommandResultOutcome),
    Effect.catchAll((error) => Effect.succeed({ _tag: "failure", error } satisfies CommandResultOutcome)),
  ) as Effect.Effect<CommandResultOutcome, never>;

interface Harness {
  readonly deps: McpDispatchDeps;
  readonly events: LandoEvent[];
}

const harness = (
  entries: ReadonlyArray<McpCommandEntry>,
  options: { readonly allow?: ReadonlyArray<string>; readonly secrets?: ReadonlyArray<string> } = {},
): Harness => {
  const events: LandoEvent[] = [];
  const registry = new Map(entries.map((e) => [e.spec.id, e] as const));
  const allowlist = new Set(options.allow ?? entries.map((e) => e.spec.id));
  return {
    events,
    deps: {
      registry,
      effective: allowlist,
      allowlistSource: "defaults",
      redactor: createRedactor("secrets", { values: [...(options.secrets ?? [])] }),
      execute: directExecute(),
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    },
  };
};

describe("dispatchTool", () => {
  test("returns an ok envelope for a successful command", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:info", () => Effect.succeed({ name: "demo" }), {
        resultSchema: Schema.Struct({ name: Schema.String }),
      }),
    };
    const { deps, events } = harness([entry]);
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:info" }, deps));
    expect(result.ok).toBe(true);
    expect(result.envelope).toMatchObject({
      apiVersion: "v4",
      command: "app:info",
      ok: true,
      result: { name: "demo" },
    });
    expect(events.map((e) => e._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    expect(events[1]).toMatchObject({ outcome: "success" });
  });

  test("forces command execution to be non-interactive", async () => {
    let observedInteraction: "non-interactive" | undefined;
    const entry: McpCommandEntry = {
      spec: spec("app:info", () => Effect.succeed({})),
    };
    const { deps } = harness([entry]);

    const result = await Effect.runPromise(
      dispatchTool(
        { toolId: "app:info" },
        {
          ...deps,
          execute: (_entry, runInput) =>
            Effect.sync(() => {
              observedInteraction = runInput.interaction;
              return { _tag: "success", value: {} } satisfies CommandResultOutcome;
            }),
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(observedInteraction).toBe("non-interactive");
  });

  test("surfaces a command's tagged failure as an ok:false envelope, not an MCP error", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:start", () =>
        Effect.fail(new PromptRequiredError({ message: "answer required", remediation: "pass --yes" })),
      ),
    };
    const { deps, events } = harness([entry]);
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:start" }, deps));
    expect(result.ok).toBe(false);
    expect(result.envelope).toMatchObject({ ok: false, error: { _tag: "RecipeMissingAnswerError" } });
    expect(events[1]).toMatchObject({ outcome: "failure", failureDetail: "RecipeMissingAnswerError" });
  });

  test("rejects a tool outside the effective allowlist and still publishes both events", async () => {
    const entry: McpCommandEntry = { spec: spec("app:info", () => Effect.succeed({})) };
    const { deps, events } = harness([entry], { allow: [] });
    const exit = await Effect.runPromiseExit(dispatchTool({ toolId: "app:info" }, deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(McpToolNotAllowedError);
    }
    expect(events.map((e) => e._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
  });

  test("reports an allowed tool missing from the registry as unavailable", async () => {
    const { deps, events } = harness([], { allow: ["app:php"] });
    const exit = await Effect.runPromiseExit(dispatchTool({ toolId: "app:php" }, deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(McpTransportError);
      expect(error).toMatchObject({
        message: expect.stringContaining("is not available"),
        remediation: expect.stringContaining("tooling"),
      });
    }
    expect(events.map((e) => e._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
  });

  test("rejects an invalid input with McpToolInputError carrying the flag path", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:logs", () => Effect.succeed({}), {
        flags: { format: { type: "string", required: true } },
      }),
    };
    const { deps } = harness([entry]);
    const exit = await Effect.runPromiseExit(
      dispatchTool({ toolId: "app:logs", input: { flags: {} } }, deps),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
      expect((exit.cause.error as McpToolInputError).path).toBe("flags.format");
    }
  });

  test("rejects write-shaped app config projection input before execution", async () => {
    const projected = mcpRegistryFromCompiled({
      "app:config": { landoSpec: spec("app:config", () => Effect.succeed({})) },
    });
    let executed = false;
    const getEntry = projected.commandEntries.find((entry) => entry.spec.id === "app:config:get");
    expect(getEntry).toBeDefined();
    if (getEntry === undefined) return;
    const { deps } = harness([getEntry]);

    const exit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:config:get", input: { args: { key: "name", subcommand: "set" } } },
        {
          ...deps,
          execute: () =>
            Effect.sync(() => {
              executed = true;
              return { _tag: "success", value: {} } satisfies CommandResultOutcome;
            }),
        },
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(executed).toBe(false);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(McpToolInputError);
      expect((exit.cause.error as McpToolInputError).path).toBe("args.subcommand");
    }
  });

  test("publishes post event when command execution is interrupted", async () => {
    const entry: McpCommandEntry = { spec: spec("app:exec", () => Effect.never) };
    const { deps, events } = harness([entry]);
    const exit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:exec" },
        {
          ...deps,
          execute: () => Effect.interrupt,
        },
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(events.map((e) => e._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    expect(events[1]).toMatchObject({ outcome: "failure", failureDetail: "Interrupted" });
  });

  test("redacts secret values before the envelope crosses the transport", async () => {
    const secret = "sk-super-secret-token";
    const entry: McpCommandEntry = {
      spec: spec("app:info", () => Effect.succeed({ token: secret }), {
        resultSchema: Schema.Struct({ token: Schema.String }),
      }),
    };
    const { deps } = harness([entry], { secrets: [secret] });
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:info" }, deps));
    expect(JSON.stringify(result.envelope)).not.toContain(secret);
  });

  test("rejects unsafe result traversal before the result schema can invoke it", async () => {
    // Given
    let getterCalls = 0;
    let trapCalls = 0;
    const accessorResult = {
      get nested(): { readonly value: string } {
        getterCalls += 1;
        return { value: "not-read" };
      },
    };
    const nestedProxy = new Proxy(
      { value: "not-read" },
      {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const entry: McpCommandEntry = {
      spec: spec("app:unsafe-result", () => Effect.succeed({}), {
        resultSchema: Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
      }),
    };
    const { deps } = harness([entry]);

    // When
    const accessorExit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:unsafe-result" },
        {
          ...deps,
          execute: () => Effect.succeed({ _tag: "success", value: accessorResult }),
        },
      ),
    );
    const proxyExit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:unsafe-result" },
        {
          ...deps,
          execute: () => Effect.succeed({ _tag: "success", value: { nested: nestedProxy } }),
        },
      ),
    );

    // Then
    for (const exit of [accessorExit, proxyExit]) {
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(McpTransportError);
      }
    }
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });

  test("publishes a bounded post event when pre-schema inspection rejects a result", async () => {
    // Given
    const omittedKey = "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1);
    const entry: McpCommandEntry = {
      spec: spec("app:unsafe-result", () => Effect.succeed({}), { resultSchema: Schema.Unknown }),
    };
    const { deps, events } = harness([entry]);

    // When
    const exit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:unsafe-result" },
        {
          ...deps,
          execute: () => Effect.succeed({ _tag: "success", value: { [omittedKey]: undefined } }),
        },
      ),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    expect(events.map((event) => event._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    expect(events[1]).toMatchObject({ outcome: "failure", failureDetail: "McpTransportError" });
  });

  test("bounds app references before publishing lifecycle events", async () => {
    // Given
    const entry: McpCommandEntry = { spec: spec("app:info", () => Effect.succeed({})) };
    const { deps, events } = harness([entry], { secrets: ["a"] });

    // When
    await Effect.runPromise(
      dispatchTool({ toolId: "app:info", input: { appPath: "a".repeat(900_000) } }, deps),
    );

    // Then
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ appRef: REDACTED });
    expect(events[1]).toMatchObject({ appRef: REDACTED });
  });

  test("redacts rejected tool ids in MCP lifecycle events", async () => {
    // Given
    const secretToolId = "sk-event-secret";
    const { deps, events } = harness([], { allow: [], secrets: [secretToolId] });

    // When
    const exit = await Effect.runPromiseExit(dispatchTool({ toolId: secretToolId }, deps));

    // Then
    expect(exit._tag).toBe("Failure");
    expect(events.map((event) => event._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    expect(JSON.stringify(events)).not.toContain(secretToolId);
  });

  test("publishes a post event when command execution dies", async () => {
    // Given
    const entry: McpCommandEntry = { spec: spec("app:exec", () => Effect.succeed({})) };
    const { deps, events } = harness([entry]);

    // When
    const exit = await Effect.runPromiseExit(
      dispatchTool({ toolId: "app:exec" }, { ...deps, execute: () => Effect.die(new Error("boom")) }),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    expect(events.map((event) => event._tag)).toEqual(["pre-mcp-call", "post-mcp-call"]);
    expect(events[1]).toMatchObject({ outcome: "failure", failureDetail: "Defect" });
  });

  test("rejects hostile command failures without invoking their hooks", async () => {
    // Given
    let getterCalls = 0;
    let trapCalls = 0;
    const accessorError = {
      _tag: "HostileError",
      get message(): string {
        getterCalls += 1;
        return "not-read";
      },
    };
    const proxyError = new Proxy(accessorError, {
      getOwnPropertyDescriptor: (target, key) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const entry: McpCommandEntry = { spec: spec("app:unsafe-failure", () => Effect.succeed({})) };
    const { deps, events } = harness([entry]);

    // When
    const accessorExit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:unsafe-failure" },
        { ...deps, execute: () => Effect.succeed({ _tag: "failure", error: accessorError }) },
      ),
    );
    const proxyExit = await Effect.runPromiseExit(
      dispatchTool(
        { toolId: "app:unsafe-failure" },
        { ...deps, execute: () => Effect.succeed({ _tag: "failure", error: proxyError }) },
      ),
    );

    // Then
    expect(accessorExit._tag).toBe("Failure");
    expect(proxyExit._tag).toBe("Failure");
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
    expect(events.filter((event) => event._tag === "post-mcp-call")).toHaveLength(2);
  });

  test("emits redacted streamFrames as MCP progress notifications", async () => {
    const secret = "stream-secret-token";
    const notifications: unknown[] = [];
    const entry: McpCommandEntry = {
      spec: spec("app:logs", () => Effect.succeed({ chunk: `hello ${secret}` }), {
        resultSchema: Schema.Struct({ chunk: Schema.String }),
        streamFrames: (value) => {
          const record = Schema.decodeUnknownSync(Schema.Struct({ chunk: Schema.String }))(value);
          return [{ _tag: "stdout", chunk: record.chunk }];
        },
      }),
    };
    const { deps } = harness([entry], { secrets: [secret] });

    const result = await Effect.runPromise(
      dispatchTool(
        { toolId: "app:logs" },
        {
          ...deps,
          notify: (frame) =>
            Effect.sync(() => {
              notifications.push(frame);
            }),
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications[0])).not.toContain(secret);
    expect(notifications[0]).toMatchObject({ _tag: "stdout" });
  });

  test("rejects hostile streamFrames without invoking getters or proxy traps", async () => {
    // Given
    let getterCalls = 0;
    let trapCalls = 0;
    const accessorFrame = {
      _tag: "stdout" as const,
      get chunk(): string {
        getterCalls += 1;
        return "not-read";
      },
    };
    const proxyFrame = new Proxy(
      { _tag: "stderr" as const, chunk: "not-read" },
      {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    let frame: McpProgressFrame = accessorFrame;
    const entry: McpCommandEntry = {
      spec: spec("app:logs", () => Effect.succeed({}), {
        streamFrames: () => [frame],
      }),
    };
    const { deps } = harness([entry]);
    const notify = (): Effect.Effect<void> => Effect.void;

    // When
    const accessorExit = await Effect.runPromiseExit(
      dispatchTool({ toolId: "app:logs" }, { ...deps, notify }),
    );
    frame = proxyFrame;
    const proxyExit = await Effect.runPromiseExit(dispatchTool({ toolId: "app:logs" }, { ...deps, notify }));

    // Then
    for (const exit of [accessorExit, proxyExit]) {
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(McpTransportError);
      }
    }
    expect(getterCalls).toBe(0);
    expect(trapCalls).toBe(0);
  });
});
