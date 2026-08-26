import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { destroySpec } from "../../src/cli/command-specs/app/destroy.ts";
import { rebuildSpec } from "../../src/cli/command-specs/app/rebuild.ts";
import { restartSpec } from "../../src/cli/command-specs/app/restart.ts";
import { startSpec } from "../../src/cli/command-specs/app/start.ts";
import { stopSpec } from "../../src/cli/command-specs/app/stop.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";

const publishStartupTasks = Effect.gen(function* () {
  const events = yield* EventService;
  yield* events.publish({
    _tag: "task.tree.start",
    parentId: "app:start",
    label: "Starting",
    children: ["app:start:web"],
    timestamp: "2026-06-04T00:00:00.000Z",
  });
  yield* events.publish({
    _tag: "task.start",
    taskId: "app:start:web",
    parentId: "app:start",
    label: "web",
    timestamp: "2026-06-04T00:00:00.001Z",
  });
  yield* events.publish({
    _tag: "task.complete",
    taskId: "app:start:web",
    summary: "online",
    durationMs: 10,
    timestamp: "2026-06-04T00:00:00.002Z",
  });
  yield* events.publish({
    _tag: "task.tree.complete",
    parentId: "app:start",
    succeeded: 1,
    failed: 0,
    durationMs: 11,
    timestamp: "2026-06-04T00:00:00.003Z",
  });
  return {};
});

const expectPlainHumanTaskRendering = async (spec: LandoCommandSpec, finalLine: string): Promise<void> => {
  // Given: compiled options no longer carry a per-command renderEvents opt-in.
  const io = createBufferedRendererIO();
  const options = compiledCommandOptionsFromSpec(spec, {});

  // When: startup task events publish under human plain format.
  await runWithRendererHandling(publishStartupTasks, {
    runtime: Layer.empty,
    rendererMode: "plain",
    io,
    render: () => finalLine,
    formatError: () => "should not happen",
  });

  // Then: the task tree is consumed before the final human result.
  expect("renderEvents" in options).toBe(false);
  expect("renderEvents" in spec).toBe(false);
  expect(io.stdout()).toContain("▼ Starting");
  expect(io.stdout()).toContain("[app:start:web] start: web");
  expect(io.stdout().endsWith(`${finalLine}\n`)).toBe(true);
};

const HUMAN_SPECS = [
  { spec: startSpec, finalLine: "ready" },
  { spec: restartSpec, finalLine: "restarted" },
  { spec: rebuildSpec, finalLine: "rebuilt" },
  { spec: destroySpec, finalLine: "destroyed" },
  { spec: stopSpec, finalLine: "ready" },
] as const;

describe("native command renderer event consumption", () => {
  for (const { spec, finalLine } of HUMAN_SPECS) {
    test(`${spec.id} paints published task events in human mode without renderEvents`, async () => {
      await expectPlainHumanTaskRendering(spec, finalLine);
    });
  }

  test("restart json emits one envelope and no live task paint", async () => {
    // Given: native restart under JSON non-streaming, with no renderEvents opt-in.
    const io = createBufferedRendererIO();
    const options = compiledCommandOptionsFromSpec(restartSpec, {});

    // When: the same startup task events publish through the JSON result path.
    await runWithRendererHandling(publishStartupTasks, {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      io,
      command: restartSpec.id,
      resultSchema: Schema.Struct({}),
      render: () => undefined,
      formatError: () => "should not happen",
    });

    // Then: stdout is one schema-valid envelope and stderr has no task paint.
    expect("renderEvents" in options).toBe(false);
    const stdoutLines = io.stdoutLines();
    expect(stdoutLines).toHaveLength(1);
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdoutLines[0] ?? "{}"))).toMatchObject(
      {
        apiVersion: "v4",
        command: "app:restart",
        ok: true,
        result: {},
      },
    );
    expect(io.stderr()).not.toContain("task.tree.start");
    expect(io.stderr()).not.toContain("task.start");
    expect(io.stderr()).not.toContain("▼");
  });

  test("destroy json emits one envelope and no live task paint", async () => {
    // Given: native destroy under JSON non-streaming.
    const io = createBufferedRendererIO();

    // When: synthetic task events publish through the JSON result path.
    await runWithRendererHandling(publishStartupTasks, {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      io,
      command: destroySpec.id,
      resultSchema: Schema.Struct({}),
      render: () => undefined,
      formatError: () => "should not happen",
    });

    // Then: stdout is one schema-valid envelope and stderr has no task paint.
    const stdoutLines = io.stdoutLines();
    expect(stdoutLines).toHaveLength(1);
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdoutLines[0] ?? "{}"))).toMatchObject(
      {
        apiVersion: "v4",
        command: "app:destroy",
        ok: true,
        result: {},
      },
    );
    expect(io.stderr()).not.toContain("task.tree.start");
    expect(io.stderr()).not.toContain("task.start");
    expect(io.stderr()).not.toContain("▼");
  });

  test("rebuild json streaming skips live task paint", async () => {
    // Given: native rebuild already streams JSON.
    const io = createBufferedRendererIO();

    // When: the same startup task events publish on the streaming JSON path.
    await runWithRendererHandling(publishStartupTasks, {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      io,
      command: rebuildSpec.id,
      resultSchema: Schema.Struct({}),
      ...(rebuildSpec.streaming === undefined ? {} : { streaming: rebuildSpec.streaming }),
      render: () => undefined,
      formatError: () => "should not happen",
    });

    // Then: the live consumer stays off and stderr has no task paint.
    expect(rebuildSpec.streaming).toBeDefined();
    expect(io.stderr()).not.toContain("task.tree.start");
    expect(io.stderr()).not.toContain("task.start");
    expect(io.stderr()).not.toContain("▼");
  });
});
