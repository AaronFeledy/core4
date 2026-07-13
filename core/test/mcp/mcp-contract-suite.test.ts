/**
 * MCP contract suite — regression gate for the MCP command surface.
 *
 * Asserts against the test runtime (no live agent client) the safety and
 * schema-fidelity properties every release must keep:
 *
 *   1. catalog generation matches the committed allowlist cache
 *   2. tool input schemas round-trip against the command `FlagSpec`/`ArgSpec`
 *   3. success AND failure dispatches return schema-valid command envelopes
 *   4. deny wins over allow
 *   5. destructive-id self-allow registration is rejected
 *   6. a non-interactive prompt failure surfaces as a structured `ok:false`
 *   7. cancellation mid-call fails with an MCP transport error
 *   8. concurrency is capped at `mcp.maxConcurrent`
 *   9. a known secret never crosses the transport
 *
 * allow: SIZE_OK — acceptance bullets stay collocated in one discoverable suite.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Schema } from "effect";

import { McpAllowlistConflictError, McpToolInputError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { mcpRegistryFromCompiled } from "../../src/cli/commands/meta/mcp.ts";
import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { MCP_DEFAULT_ALLOWLIST } from "../../src/cli/oclif/generated/mcp-allowlist.ts";
import { assertMcpAllowlistSafe } from "../../src/cli/oclif/mcp-allowlist.ts";
import { buildCatalog, computeEffectiveAllowlist } from "../../src/mcp/catalog.ts";
import { type McpDispatchDeps, dispatchTool } from "../../src/mcp/dispatch.ts";
import { type McpCommandEntry, deriveToolInputSchema, validateToolInput } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { McpTransport, makeInMemoryTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";

/** A prompt-required tagged failure, standing in for interactive recipe answers. */
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
    Effect.map((value) => ({ _tag: "success", value }) as const),
    Effect.catchAll((error) => Effect.succeed({ _tag: "failure", error } as const)),
  ) as ReturnType<McpDispatchDeps["execute"]>;

interface Harness {
  readonly deps: McpDispatchDeps;
  readonly events: LandoEvent[];
}

const harness = (
  entries: ReadonlyArray<McpCommandEntry>,
  options: { readonly allow?: ReadonlyArray<string>; readonly secrets?: ReadonlyArray<string> } = {},
): Harness => {
  const events: LandoEvent[] = [];
  const registry = new Map(entries.map((entry) => [entry.spec.id, entry] as const));
  const allowlist = new Set(options.allow ?? entries.map((entry) => entry.spec.id));
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

const decodeEnvelope = (envelope: unknown): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(envelope);

const specFor = (id: string): LandoCommandSpec | undefined =>
  allCommandEntries().find((entry) => entry.spec.id === id)?.spec;

const allCommandEntries = (): ReadonlyArray<McpCommandEntry> =>
  mcpRegistryFromCompiled(compiledCommands as Record<string, { readonly landoSpec?: LandoCommandSpec }>)
    .commandEntries;

const redactionLayer = (values: ReadonlyArray<string> = []) =>
  Layer.succeed(RedactionService, {
    forProfile: () => Effect.succeed(createRedactor("secrets", { values })),
  });

const serviceLayer = (config: McpRuntimeConfigShape) =>
  McpServiceLive.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(McpRuntimeConfig, config), redactionLayer())),
  );

describe("MCP contract suite — catalog matches the allowlist cache", () => {
  test("projecting the full command registry through the default allowlist equals the committed cache", () => {
    const catalog = buildCatalog({
      commandEntries: allCommandEntries(),
      effective: computeEffectiveAllowlist({ defaults: MCP_DEFAULT_ALLOWLIST }),
    });
    expect(catalog.tools.map((tool) => tool.toolId)).toEqual([...MCP_DEFAULT_ALLOWLIST]);
  });

  test("every catalog tool id is a member of the effective allowlist", () => {
    const effective = computeEffectiveAllowlist({ defaults: MCP_DEFAULT_ALLOWLIST });
    const catalog = buildCatalog({ commandEntries: allCommandEntries(), effective });
    for (const tool of catalog.tools) expect(effective.ids.has(tool.toolId)).toBe(true);
  });

  test("every cached default id resolves to a real command spec", () => {
    for (const id of MCP_DEFAULT_ALLOWLIST) expect(specFor(id)).toBeDefined();
  });

  test("app config defaults are read-only projections and the umbrella is absent", () => {
    const ids = allCommandEntries().map((entry) => entry.spec.id);
    expect(MCP_DEFAULT_ALLOWLIST).toContain("app:config:get");
    expect(MCP_DEFAULT_ALLOWLIST).toContain("app:config:view");
    expect(ids).not.toContain("app:config");
  });
});

describe("MCP contract suite — tool input schemas round-trip against FlagSpec/ArgSpec", () => {
  test("each default tool derives a closed flags/args object matching its declared spec", () => {
    for (const id of MCP_DEFAULT_ALLOWLIST) {
      const commandSpec = specFor(id);
      expect(commandSpec).toBeDefined();
      if (commandSpec === undefined) continue;
      const schema = deriveToolInputSchema(commandSpec) as {
        readonly type: string;
        readonly additionalProperties: boolean;
        readonly properties: {
          readonly flags: { readonly properties: Record<string, unknown> };
          readonly args: { readonly properties: Record<string, unknown> };
        };
      };
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties.flags.properties).sort()).toEqual(
        Object.keys(commandSpec.flags ?? {}).sort(),
      );
      expect(Object.keys(schema.properties.args.properties).sort()).toEqual(
        Object.keys(commandSpec.args ?? {}).sort(),
      );
    }
  });

  test("validateToolInput accepts a conforming payload and normalizes it", () => {
    const commandSpec = spec("app:logs", () => Effect.succeed({}), {
      flags: { format: { type: "string", required: true }, follow: { type: "boolean" } },
      args: { service: { type: "string" } },
    });
    const result = validateToolInput(commandSpec, {
      flags: { format: "json", follow: true },
      args: { service: "web" },
    });
    expect(result).toEqual({ flags: { format: "json", follow: true }, args: { service: "web" } });
  });

  test("validateToolInput rejects unknown, mistyped, and missing-required members with a path", () => {
    const commandSpec = spec("app:logs", () => Effect.succeed({}), {
      flags: { format: { type: "string", required: true } },
    });
    expect(() => validateToolInput(commandSpec, { flags: { format: 1 } })).toThrow(McpToolInputError);
    expect(() => validateToolInput(commandSpec, { flags: {} })).toThrow(McpToolInputError);
    try {
      validateToolInput(commandSpec, { flags: { nope: "x" } });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolInputError);
      expect((error as McpToolInputError).path).toBe("flags.nope");
    }
  });
});

describe("MCP contract suite — success and failure dispatches return schema-valid envelopes", () => {
  test("a successful dispatch returns an ok:true envelope that decodes against CommandResultEnvelope", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:info", () => Effect.succeed({ name: "demo" }), {
        resultSchema: Schema.Struct({ name: Schema.String }),
      }),
    };
    const { deps } = harness([entry]);
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:info" }, deps));
    expect(result.ok).toBe(true);
    const envelope = decodeEnvelope(result.envelope);
    expect(envelope).toMatchObject({ apiVersion: "v4", command: "app:info", ok: true });
  });

  test("a tagged command failure returns an ok:false envelope that decodes against CommandResultEnvelope", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:start", () =>
        Effect.fail(new PromptRequiredError({ message: "answer required", remediation: "pass --yes" })),
      ),
    };
    const { deps } = harness([entry]);
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:start" }, deps));
    expect(result.ok).toBe(false);
    const envelope = decodeEnvelope(result.envelope);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?._tag).toBe("RecipeMissingAnswerError");
  });
});

describe("MCP contract suite — deny wins over allow", () => {
  test("an id in both allow and deny is excluded from the effective set", () => {
    const effective = computeEffectiveAllowlist({ defaults: [], allow: ["app:info"], deny: ["app:info"] });
    expect(effective.ids.has("app:info")).toBe(false);
  });

  test("a denied default id never appears in the catalog", () => {
    const entries: ReadonlyArray<McpCommandEntry> = [{ spec: spec("app:info", () => Effect.succeed({})) }];
    const catalog = buildCatalog({
      commandEntries: entries,
      effective: computeEffectiveAllowlist({ defaults: ["app:info"], deny: ["app:info"] }),
    });
    expect(catalog.tools).toHaveLength(0);
  });
});

describe("MCP contract suite — destructive-id self-allow registration is rejected", () => {
  test("a destructive id that self-allows is rejected with McpAllowlistConflictError", () => {
    expect(() => assertMcpAllowlistSafe({ id: "app:destroy", mcpAllowed: true })).toThrow(
      McpAllowlistConflictError,
    );
  });

  test("a read-only id that self-allows is accepted", () => {
    expect(() => assertMcpAllowlistSafe({ id: "app:info", mcpAllowed: true })).not.toThrow();
  });
});

describe("MCP contract suite — non-interactive prompt failure surfaces as structured ok:false", () => {
  test("a command that requires a prompt fails as an ok:false envelope under non-interactive dispatch", async () => {
    const entry: McpCommandEntry = {
      spec: spec("app:start", (input) =>
        (input as { readonly interaction?: string }).interaction === "non-interactive"
          ? Effect.fail(
              new PromptRequiredError({
                message: "This command requires an interactive answer.",
                remediation: "Provide the answer as a flag instead of relying on a prompt.",
              }),
            )
          : Effect.succeed({}),
      ),
    };
    const { deps } = harness([entry]);
    const result = await Effect.runPromise(dispatchTool({ toolId: "app:start" }, deps));
    expect(result.ok).toBe(false);
    expect(decodeEnvelope(result.envelope).error?._tag).toBe("RecipeMissingAnswerError");
  });
});

describe("MCP contract suite — cancellation mid-call", () => {
  test("canceling an in-flight transport request interrupts the running command", async () => {
    let finalized = false;
    const blocking = spec("app:exec", () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: blocking }],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };
    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      const id = yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("10 millis");
      yield* inmem.cancel(id);
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { id, replies };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const { id, replies } = await Effect.runPromise(program);

    expect(finalized).toBe(true);
    expect(replies).toEqual([
      { id, ok: false, error: expect.objectContaining({ _tag: "McpTransportError" }) },
    ]);
  });
});

describe("MCP contract suite — concurrency cap", () => {
  test("serve never runs more than mcp.maxConcurrent commands at once", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = spec("app:exec", () =>
      Effect.gen(function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.promise(() => gate);
        active -= 1;
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: blocking }],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };
    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio", maxConcurrent: 1 })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      for (let index = 0; index < 4; index += 1) yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("80 millis");
      const observedMax = maxActive;
      release();
      while ((yield* inmem.replies).length < 4) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { observedMax, replies: replies.length };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));
    const outcome = await Effect.runPromise(program);
    expect(outcome.observedMax).toBe(1);
    expect(outcome.replies).toBe(4);
  });
});

describe("MCP contract suite — a known secret never crosses the transport", () => {
  test("a secret in a command result is redacted before the envelope is returned", async () => {
    const secret = "sk-contract-suite-secret-token";
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
