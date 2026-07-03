import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { renderer as landoContribution } from "@lando/renderer-lando";

import { EventService, Renderer } from "@lando/sdk/services";

import {
  bundledRendererRegistry,
  landoRenderer,
  resolveBundledRenderer,
} from "../../../src/cli/renderer/bundled-renderers.ts";
import { createBufferedRendererIO } from "../../../src/cli/renderer/io.ts";
import { EventServiceLive } from "../../../src/services/event-service.ts";

describe("bundled renderer resolution", () => {
  test("the @lando/renderer-lando plugin exports the real lando renderer contribution", () => {
    expect(Layer.isLayer(landoContribution)).toBe(false);
    expect(landoContribution.id).toBe("lando");
    expect(typeof landoContribution.makeService).toBe("function");
    expect(typeof landoContribution.makeEventConsumer).toBe("function");
  });

  test("core resolves the plugin's contribution by identity, not by reconstruction", () => {
    expect(landoRenderer).toBe(landoContribution);
    expect(resolveBundledRenderer("lando")).toBe(landoContribution);
    expect(bundledRendererRegistry.get("lando")).toBe(landoContribution);
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
      yield* events.publish({
        _tag: "task.start",
        taskId: "web",
        label: "start web",
        timestamp: new Date().toISOString(),
      } as never);
      yield* Effect.sleep("20 millis");
    });
    const layer = Layer.provideMerge(landoRenderer.makeEventConsumer(io), EventServiceLive);
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(io.stdoutLines()).toEqual(["[web] start: start web"]);
    expect(io.stderr()).toBe("");
  });
});
