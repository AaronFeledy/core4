import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { TaskStartEvent } from "@lando/sdk/events";
import { EventService, Renderer } from "@lando/sdk/services";

import { EventServiceLive } from "../../../src/testing/engine-layers";
import {
  bundledRendererRegistry,
  landoRenderer,
  resolveBundledRenderer,
} from "../../../src/cli/renderer/bundled-renderers.ts";
import { createBufferedRendererIO } from "../../../src/cli/renderer/io.ts";
import { BUNDLED_RENDERER_MODULES } from "../../../src/plugins/generated/renderers.ts";

describe("bundled renderer resolution", () => {
  test("core resolves the generated descriptor contribution by identity", () => {
    const landoDescriptor = BUNDLED_RENDERER_MODULES.find((module) =>
      module.renderers?.has("lando"),
    )?.renderers?.get("lando");
    if (landoDescriptor === undefined) {
      throw new Error('Generated renderer descriptors must include "lando".');
    }

    expect(Layer.isLayer(landoDescriptor)).toBe(false);
    expect(landoDescriptor.id).toBe("lando");
    expect(typeof landoDescriptor.makeService).toBe("function");
    expect(typeof landoDescriptor.makeEventConsumer).toBe("function");
    expect(typeof landoDescriptor.loadInteractivePromptDriver).toBe("function");
    expect(landoRenderer).toBe(landoDescriptor);
    expect(resolveBundledRenderer("lando")).toBe(landoDescriptor);
    expect(bundledRendererRegistry.get("lando")).toBe(landoDescriptor);
  });

  test("resolving an unknown renderer id fails with a clear error", () => {
    expect(() => resolveBundledRenderer("nope")).toThrow(
      'Bundled renderer "nope" is not registered by any bundled renderer plugin.',
    );
  });

  test("the resolved lando service reports id lando", () => {
    const io = createBufferedRendererIO();
    const id = Effect.runSync(
      Effect.provide(
        Effect.map(Renderer, (renderer) => renderer.id),
        landoRenderer.makeService(io),
      ),
    );
    expect(id).toBe("lando");
  });

  test("the resolved lando renderer paints a task event to a non-TTY buffer", async () => {
    const io = createBufferedRendererIO();
    const program = Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(
        Schema.decodeUnknownSync(TaskStartEvent)({
          _tag: "task.start",
          taskId: "web",
          label: "start web",
          timestamp: new Date().toISOString(),
        }),
      );
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdoutLines()).toEqual(["[web] start: start web"]);
    expect(io.stderr()).toBe("");
  });
});
