import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deriveToolInputSchema } from "@lando/mcp/registry";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { InteractionService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Cause, Effect, Exit, Layer, Result } from "effect";
import { destroySpec, runDestroyCommand } from "../../src/cli/command-specs/app/destroy";
import { rebuildSpec, runRebuildCommand } from "../../src/cli/command-specs/app/rebuild";
import { metaGlobalDestroySpec } from "../../src/cli/command-specs/meta/global/destroy";
import { commandErrorMessage } from "../../src/cli/compiled-runtime";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { type AppRuntimeServices, makeLandoRuntime } from "../../src/runtime/layer";
import { makeTestInteractionService } from "../../src/testing/interaction";

describe("lifecycle confirmation boundary", () => {
  const confirmationRoot = resolve("missing-confirmation-app");
  test.each([
    {
      flags: { root: confirmationRoot, volumes: true },
      message: `Delete the containers and data volumes left by ${confirmationRoot}?`,
    },
    {
      flags: { root: confirmationRoot, "purge-caches": true },
      message: `Delete the containers, cache volumes and built images left by ${confirmationRoot}? Named data volumes are kept.`,
    },
    { flags: {}, message: "Delete this app's containers? Named data volumes are kept." },
    { flags: { volumes: true }, message: "Delete this app's containers and data volumes?" },
    {
      flags: { "purge-caches": true },
      message: "Delete this app's containers, cache volumes and built images? Named data volumes are kept.",
    },
    { flags: { purge: true }, message: "Delete this app's containers, data volumes and snapshots?" },
    {
      flags: { volumes: true, "purge-caches": true },
      message: "Delete this app's containers, data volumes, cache volumes and built images?",
    },
    {
      flags: { purge: true, "purge-caches": true },
      message: "Delete this app's containers, data volumes, snapshots, cache volumes and built images?",
    },
  ])(
    "destroy confirmation leads with what it deletes and declines before engine access: $message",
    async ({ flags, message }) => {
      const interaction = makeTestInteractionService({ answers: { confirm: "false" } });
      const result = await Effect.runPromise(
        runDestroyCommand({ flags }).pipe(
          Effect.provide(
            makeLandoRuntime({ bootstrap: "app", telemetry: false }).pipe(
              Layer.merge(
                Layer.succeed(
                  InteractionService,
                  InteractionService.of({
                    ...interaction.service,
                    isInteractive: Effect.succeed(true),
                  }),
                ),
              ),
              Layer.merge(
                Layer.succeed(
                  RuntimeProviderRegistry,
                  RuntimeProviderRegistry.of({
                    readAppliedPlanStrict: () => Effect.succeed(undefined),
                    appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
                    resolveAppliedPlan: () => Effect.succeed(undefined),
                    appliedPlansFor: () => Effect.succeed([]),
                    list: Effect.die("Unexpected provider list"),
                    capabilities: Effect.die("Unexpected capabilities"),
                    select: () => Effect.die("Unexpected provider selection"),
                    resolveTeardownEvidence: () => Effect.die("Unexpected teardown resolution"),
                  }),
                ),
              ),
            ),
          ),
          Effect.result,
        ),
      );
      if (result._tag !== "Failure") throw new TypeError("expected declined confirmation");
      expect(result.failure).toMatchObject({ _tag: "CommandConfirmationError", reason: "declined" });
      expect(interaction.transcript()).toHaveLength(1);
      expect(interaction.transcript()[0]?.message).toBe(message);
    },
  );

  for (const { spec, run } of [
    { spec: destroySpec, run: runDestroyCommand },
    { spec: rebuildSpec, run: runRebuildCommand },
  ]) {
    for (const interactive of [false, true]) {
      test(`${spec.id} stops before resolving engine services when confirmation is unavailable or declined (${interactive})`, async () => {
        // Given: engine entry services defect if called before confirmation.
        const interaction = makeTestInteractionService({ answers: { confirm: "false" } });
        const io = createBufferedRendererIO();
        const codes: number[] = [];
        const runtime = Layer.mergeAll(
          makeLandoRuntime({ bootstrap: "app", telemetry: false }),
          Layer.succeed(
            InteractionService,
            InteractionService.of({
              ...interaction.service,
              isInteractive: Effect.succeed(interactive),
            }),
          ),
          Layer.succeed(
            LandofileService,
            LandofileService.of({ discover: Effect.die("Unexpected app discovery") }),
          ),
          Layer.succeed(
            RuntimeProviderRegistry,
            RuntimeProviderRegistry.of({
              readAppliedPlanStrict: () => Effect.succeed(undefined),
              appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
              resolveAppliedPlan: () => Effect.succeed(undefined),
              resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
              appliedPlansFor: () => Effect.succeed([]),
              list: Effect.die("Unexpected provider list"),
              capabilities: Effect.die("Unexpected provider capabilities"),
              select: () => Effect.die("Unexpected provider selection"),
            }),
          ),
        );
        // When
        const command: Effect.Effect<unknown, unknown, AppRuntimeServices> = run({ flags: {} });
        await runWithRendererHandling(command, {
          runtime,
          io,
          command: spec.id,
          resultFormat: "json",
          rendererMode: "plain",
          formatError: (failure) => commandErrorMessage(failure, spec.id),
          resultSchema: spec.resultSchema,
          setExitCode: (code) => codes.push(code),
        });
        // Then: a typed refusal, not a missing engine service or provider failure.
        expect(JSON.parse(io.stdout())).toMatchObject({
          ok: false,
          error: {
            _tag: "CommandConfirmationError",
            reason: interactive ? "declined" : "non-interactive",
            message: expect.any(String),
            remediation: expect.stringContaining("--yes"),
          },
        });
        expect(codes).toEqual([1]);
        expect(spec.run).toBe(run);
        expect(interaction.transcript()).toHaveLength(interactive ? 1 : 0);
      });
    }
  }

  test("MCP rebuild schema accepts explicit confirmation", () => {
    // Given / When
    const schema = deriveToolInputSchema(rebuildSpec);
    // Then
    expect(schema).toMatchObject({ properties: { flags: { properties: { yes: { type: "boolean" } } } } });
  });
});

describe("global destroy confirmation boundary", () => {
  test.each([
    { mode: "default", flags: {} },
    { mode: "volumes", flags: { volumes: true } },
    { mode: "purge", flags: { purge: true } },
  ])("honors a declined $mode confirmation before engine access", async ({ flags }) => {
    const interaction = makeTestInteractionService({ answers: { confirm: "false" } });
    const result = await Effect.runPromise(
      metaGlobalDestroySpec.run({ flags }).pipe(
        Effect.provide(
          Layer.succeed(
            InteractionService,
            InteractionService.of({
              ...interaction.service,
              isInteractive: Effect.succeed(true),
            }),
          ),
        ),
        Effect.result,
      ) as Effect.Effect<Result.Result<unknown, unknown>, never, never>,
    );

    if (Result.isSuccess(result)) throw new TypeError("expected declined confirmation");
    expect(result.failure).toMatchObject({ _tag: "CommandConfirmationError", reason: "declined" });
    expect(interaction.transcript()).toMatchObject([{ name: "confirm", type: "confirm" }]);
  });

  test("non-interactive runs fail with the --yes remediation and touch nothing", async () => {
    const interaction = makeTestInteractionService({ answers: { confirm: "true" } });
    const result = await Effect.runPromise(
      metaGlobalDestroySpec.run({ flags: {} }).pipe(
        Effect.provide(
          Layer.succeed(
            InteractionService,
            InteractionService.of({
              ...interaction.service,
              isInteractive: Effect.succeed(false),
            }),
          ),
        ),
        Effect.result,
      ) as Effect.Effect<Result.Result<unknown, unknown>, never, never>,
    );

    if (Result.isSuccess(result)) throw new TypeError("expected non-interactive refusal");
    expect(result.failure).toMatchObject({
      _tag: "CommandConfirmationError",
      reason: "non-interactive",
      remediation: expect.stringContaining("--yes"),
    });
  });

  test("confirmation precedes engine access", async () => {
    const interaction = makeTestInteractionService({ answers: { confirm: "true" } });
    const exit = await Effect.runPromiseExit(
      metaGlobalDestroySpec.run({ flags: {} }).pipe(
        Effect.provide(
          Layer.succeed(
            InteractionService,
            InteractionService.of({
              ...interaction.service,
              isInteractive: Effect.succeed(true),
            }),
          ),
        ),
      ) as Effect.Effect<unknown, unknown, never>,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(interaction.transcript()).toHaveLength(1);
    // The die proves execution passed confirmation and reached the engine; a refusal would be typed.
    expect(Exit.isFailure(exit) ? exit.cause.reasons.some(Cause.isDieReason) : false).toBe(true);
    expect(Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason) : []).toHaveLength(0);
  });
});
