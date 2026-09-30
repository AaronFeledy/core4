import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { deriveToolInputSchema } from "@lando/mcp/registry";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { InteractionService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { destroySpec, runDestroyCommand } from "../../src/cli/command-specs/app/destroy";
import { rebuildSpec, runRebuildCommand } from "../../src/cli/command-specs/app/rebuild";
import { commandErrorMessage } from "../../src/cli/compiled-runtime";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { type AppRuntimeServices, makeLandoRuntime } from "../../src/runtime/layer";
import { makeTestInteractionService } from "../../src/testing/interaction";

describe("lifecycle confirmation boundary", () => {
  test("destroy root confirmation names the folder and declines before engine access", async () => {
    const root = resolve("missing-confirmation-app");
    const interaction = makeTestInteractionService({ answers: { confirm: "false" } });
    const result = await Effect.runPromise(
      runDestroyCommand({ flags: { root, volumes: true } }).pipe(
        Effect.provide(
          makeLandoRuntime({ bootstrap: "app", telemetry: false }).pipe(
            Layer.merge(
              Layer.succeed(InteractionService, {
                ...interaction.service,
                isInteractive: Effect.succeed(true),
              }),
            ),
            Layer.merge(
              Layer.succeed(RuntimeProviderRegistry, {
                list: Effect.die("Unexpected provider list"),
                capabilities: Effect.die("Unexpected capabilities"),
                select: () => Effect.die("Unexpected provider selection"),
                resolveTeardownEvidence: () => Effect.die("Unexpected teardown resolution"),
              }),
            ),
          ),
        ),
        Effect.either,
      ),
    );
    if (result._tag !== "Left") throw new TypeError("expected declined confirmation");
    expect(result.left).toMatchObject({ _tag: "CommandConfirmationError", reason: "declined" });
    expect(interaction.transcript()).toHaveLength(1);
    expect(interaction.transcript()[0]?.message).toContain(root);
    expect(interaction.transcript()[0]?.message).toContain("no longer exists");
    expect(interaction.transcript()[0]?.message).toContain("Volumes are deleted");
  });

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
          Layer.succeed(InteractionService, {
            ...interaction.service,
            isInteractive: Effect.succeed(interactive),
          }),
          Layer.succeed(LandofileService, { discover: Effect.die("Unexpected app discovery") }),
          Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.die("Unexpected provider list"),
            capabilities: Effect.die("Unexpected provider capabilities"),
            select: () => Effect.die("Unexpected provider selection"),
          }),
        );
        // When
        const command: Effect.Effect<unknown, unknown, AppRuntimeServices> = run({ flags: {} });
        await runWithRendererHandling(command, {
          runtime,
          io,
          command: spec.id,
          resultFormat: "json",
          rendererMode: "plain",
          formatError: commandErrorMessage,
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
