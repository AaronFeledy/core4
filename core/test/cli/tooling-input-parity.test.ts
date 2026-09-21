import { expect, test } from "bun:test";
import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import { runTooling } from "@lando/engine/operations/tooling";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { dispatchTool } from "@lando/mcp/dispatch";
import { RedactionService } from "@lando/redaction/service";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { AbsolutePath, AppId, type AppPlan, LandofileShape, ProviderId } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import {
  AppPlanner,
  LandofileService,
  Renderer,
  RuntimeProviderRegistry,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, DateTime, Effect, Either, Layer, Schema } from "effect";
import { mcpRegistryWithToolingEntries } from "../../src/cli/commands/meta/mcp.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { emptyConfigServiceLayer } from "./agent-env-test-config.ts";

const planFor = (landofile: LandofileShape): AppPlan =>
  attachEffectiveTooling(
    {
      id: AppId.make("input-parity"),
      name: "input-parity",
      slug: "input-parity",
      root: AbsolutePath.make(process.cwd()),
      provider: ProviderId.make("test"),
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: {
        resolvedAt: DateTime.unsafeMake("2026-09-15T00:00:00Z"),
        source: "/app/.lando.yml",
        runtime: 4,
      },
    },
    landofile.tooling ?? {},
  );

const harnessLayer = (input: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly invocations: ToolingInvocation[];
  readonly exitCode: number;
}) =>
  Layer.mergeAll(
    Layer.succeed(Context.GenericTag<unknown>("parity-runtime"), {}),
    Layer.succeed(LandofileService, { discover: Effect.succeed(input.landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(input.plan) }),
    Layer.succeed(Renderer, {
      id: "plain",
      capabilities: RENDERER_CAPABILITIES_NONE,
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: { stdout: () => Effect.void, stderr: () => Effect.void },
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("test")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
    Layer.succeed(ToolingEngine, {
      id: "capture",
      run: (invocation) =>
        Effect.sync(() => {
          input.invocations.push(invocation);
          return {
            tool: invocation.tool,
            service: ":lando",
            exitCode: input.exitCode,
            stdout: "",
            stderr: "",
          };
        }),
    }),
    Layer.succeed(RedactionService, { forProfile: () => Effect.succeed(createRedactor("secrets")) }),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    emptyConfigServiceLayer,
  );

test.each([0, 7])("keeps CLI, event and MCP tooling argv and exit %i equal", async (exitCode) => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "input-parity",
    tooling: {
      inspect: {
        cmd: ["inspect"],
        flags: { mode: {}, loud: { boolean: true } },
        args: { second: { order: 2 }, first: { order: 1 } },
      },
    },
  });
  const plan = planFor(landofile);
  const invocations: ToolingInvocation[] = [];
  const layer = harnessLayer({ landofile, plan, invocations, exitCode });
  const structured = { flags: { loud: true, mode: "a b" }, args: { second: "last", first: "--first" } };
  const registry = mcpRegistryWithToolingEntries({ commandEntries: [] }, compileToolingCommands(landofile));
  const entry = registry.toolingEntries?.[0];
  if (entry === undefined) throw new Error("Missing tooling MCP projection");
  // When
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const cli = yield* runTooling({
          name: "inspect",
          args: ["--mode=a b", "--loud", "--", "--first", "last"],
        }).pipe(Effect.provide(context));
        const event = yield* makeEventCommandExecutor(context).run({
          command: "app:inspect",
          ...structured,
          argv: [],
          cwd: process.cwd(),
          plan,
        });
        const mcp = yield* dispatchTool(
          { toolId: entry.spec.id, input: structured },
          {
            registry: new Map([[entry.spec.id, entry]]),
            effective: new Set([entry.spec.id]),
            allowlistSource: "tooling",
            redactor: createRedactor("secrets"),
            execute: (target, input) =>
              target.spec.run(input).pipe(
                Effect.provide(context),
                Effect.map((value) => ({ _tag: "success", value }) as const),
                Effect.catchAll((error) => Effect.succeed({ _tag: "failure", error } as const)),
              ),
          },
        );
        return { cli, event, mcp };
      }),
    ),
  );
  // Then
  expect(invocations).toHaveLength(3);
  expect(invocations[0]?.commands).toEqual([["inspect", "--mode=a b", "--loud", "--first", "last"]]);
  expect(invocations[1]?.commands).toEqual(invocations[0]?.commands);
  expect(invocations[2]?.commands).toEqual(invocations[0]?.commands);
  expect(results.cli.exitCode).toBe(exitCode);
  expect(results.event.exitCode).toBe(results.cli.exitCode);
  expect(results.mcp.envelope).toMatchObject({ result: { exitCode: results.cli.exitCode } });
  expect(results.mcp.ok).toBe(true);
});

test("emits one ToolingInputError for an omitted non-trailing positional on CLI, event and MCP", async () => {
  // Given a declaration whose leading positional is optional and whose later positional has a default
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "input-parity",
    tooling: {
      inspect: { cmd: ["inspect"], args: { first: { order: 1 }, second: { order: 2, default: "b" } } },
    },
  });
  const plan = planFor(landofile);
  const invocations: ToolingInvocation[] = [];
  const layer = harnessLayer({ landofile, plan, invocations, exitCode: 0 });
  const registry = mcpRegistryWithToolingEntries({ commandEntries: [] }, compileToolingCommands(landofile));
  const entry = registry.toolingEntries?.[0];
  if (entry === undefined) throw new Error("Missing tooling MCP projection");
  // When each surface receives the input it cannot express
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const cli = yield* Effect.either(
          runTooling({ name: "inspect", args: [] }).pipe(Effect.provide(context)),
        );
        const event = yield* Effect.either(
          makeEventCommandExecutor(context).run({
            command: "app:inspect",
            flags: {},
            args: { second: "b" },
            argv: [],
            cwd: process.cwd(),
            plan,
          }),
        );
        const mcp = yield* Effect.either(
          entry.spec
            .run({ argv: [], flags: {}, args: { second: "b" }, interaction: "non-interactive" })
            .pipe(Effect.provide(context)),
        );
        return { cli, event, mcp };
      }),
    ),
  );
  // Then all three refuse with the identical tagged failure and nothing reaches the engine
  const identity = (result: Either.Either<unknown, unknown>) => {
    const error = Either.isLeft(result) ? (result.left as Record<string, unknown>) : undefined;
    if (error === undefined) return undefined;
    const { _tag, tool, field, message, remediation } = error;
    return { _tag, tool, field, message, remediation };
  };
  const expected = {
    _tag: "ToolingInputError",
    tool: "inspect",
    field: "first",
    message: "Positional argument first cannot be omitted because a later positional argument has a value.",
    remediation:
      "Supply argument first or change the tooling declaration so no later positional value follows it.",
  };
  expect(identity(results.cli)).toEqual(expected);
  expect(identity(results.event)).toEqual(expected);
  expect(identity(results.mcp)).toEqual(expected);
  expect(invocations).toHaveLength(0);
});
