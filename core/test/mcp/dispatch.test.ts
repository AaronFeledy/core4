import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { McpToolInputError, McpToolNotAllowedError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { CommandResultOutcome } from "../../src/cli/result-encode.ts";
import { type McpDispatchDeps, dispatchTool } from "../../src/mcp/dispatch.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";

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
});
