import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";

import * as LandoEventService from "@lando/engine/services/event-service";
import { NotifyDesktopEvent } from "@lando/sdk/events";
import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_TTY,
  RENDERER_CAPABILITIES_VERBOSE_TTY,
} from "@lando/sdk/renderer";
import { EventService, Renderer } from "@lando/sdk/services";

import { sanitizeNotificationText } from "../src/notify-sanitize.ts";
import { encodeDesktopNotification } from "../src/notify-trigger.ts";
import {
  landoRendererContribution,
  makeLandoEventConsumer,
  makeLandoService,
} from "../src/renderer-runtime.ts";

const runService = async <A>(layer: Layer.Layer<Renderer>, effect: Effect.Effect<A, never, Renderer>) => {
  const runtime = ManagedRuntime.make(layer);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
};

describe("RendererCapabilities matrix", () => {
  for (const isTTY of [true, false, undefined]) {
    test(`publishes synchronous capabilities when isTTY is ${String(isTTY)}`, async () => {
      const io = {
        writeStdout: () => undefined,
        writeStderr: () => undefined,
        ...(isTTY === undefined ? {} : { isTTY }),
      };
      const layer = makeLandoService(io);
      io.isTTY = !isTTY;

      const caps = await runService(
        layer,
        Effect.map(Renderer, (r) => r.capabilities),
      );

      expect(caps).toBe(isTTY === true ? RENDERER_CAPABILITIES_TTY : RENDERER_CAPABILITIES_NONE);
      expect(Object.isFrozen(caps)).toBe(true);
    });
  }

  for (const isTTY of [true, false]) {
    test(`service and event consumer agree on the first notification when isTTY is ${String(isTTY)}`, async () => {
      const writes: string[] = [];
      const io = { isTTY, writeStdout: (text: string) => writes.push(text), writeStderr: () => undefined };
      const consumer = landoRendererContribution.makeEventConsumer(io);
      if (consumer === undefined) throw new Error("Lando renderer must provide an event consumer");
      const runtime = ManagedRuntime.make(
        Layer.merge(landoRendererContribution.makeService(io), consumer).pipe(
          Layer.provideMerge(LandoEventService.layer),
        ),
      );
      const event = NotifyDesktopEvent.make({ title: "Lando\u0007", body: "done\u202E" });
      const notification = Promise.withResolvers<void>();
      const originalWrite = io.writeStdout;
      io.writeStdout = (text) => {
        originalWrite(text);
        notification.resolve();
        return writes.length;
      };

      let supported = false;
      try {
        supported = await runtime.runPromise(Effect.map(Renderer, (r) => r.capabilities.notifications));
        await runtime.runPromise(Effect.flatMap(EventService, (events) => events.publish(event)));
        if (isTTY) await notification.promise;
      } finally {
        await runtime.dispose();
      }

      expect(supported).toBe(isTTY);
      expect(writes.join("")).toBe(isTTY ? encodeDesktopNotification("done", "Lando") : "");
    });
  }

  test("flushes pending notification writes when the consumer is disposed", async () => {
    const calls: string[] = [];
    const runtime = ManagedRuntime.make(
      makeLandoEventConsumer(
        { isTTY: true, writeStdout: () => undefined, writeStderr: () => undefined },
        {
          triggerNotification: (message) => {
            calls.push(message);
            return true;
          },
          flushNotifications: async () => {
            calls.push("flushed");
          },
        },
      ).pipe(Layer.provideMerge(LandoEventService.layer)),
    );

    try {
      await runtime.runPromise(
        Effect.flatMap(EventService, (events) => events.publish(NotifyDesktopEvent.make({ title: "done" }))),
      );
    } finally {
      await runtime.dispose();
    }

    expect(calls).toEqual(["done", "flushed"]);
  });

  test("does not load OpenTUI when constructing and disposing the TTY contribution", async () => {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
        import { Effect, Layer, ManagedRuntime } from "effect";
        import * as Events from "@lando/engine/services/event-service";
        import { NotifyDesktopEvent } from "@lando/sdk/events";
        import { EventService, Renderer } from "@lando/sdk/services";
        let loads = 0;
        Reflect.set(globalThis, Symbol.for("@lando/test/opentui-loader-probe"), () => { loads += 1; });
        const { renderer } = await import("./plugins/renderer-lando/src/index.ts");
        const io = { isTTY: true, externalOutputStream: process.stdout, writeStdout: () => {}, writeStderr: () => {} };
        const runtime = ManagedRuntime.make(Layer.merge(renderer.makeService(io), renderer.makeEventConsumer(io)).pipe(Layer.provideMerge(Events.layer)));
        try {
          await runtime.runPromise(Renderer);
          await runtime.runPromise(Effect.flatMap(EventService, events => events.publish(NotifyDesktopEvent.make({ title: "done" }))));
        } finally { await runtime.dispose(); }
        await Bun.write(Bun.stdout, JSON.stringify({ loads }));
      `,
      ],
      cwd: new URL("../../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toEndWith(JSON.stringify({ loads: 0 }));
  });
});

describe("notify.desktop sanitizer", () => {
  test("strips controls, bidi overrides, and NFC-normalizes", () => {
    const raw = "a\r\nb\tc\u0007\u202Ed\u0301";
    const sanitized = sanitizeNotificationText(raw);
    expect(sanitized.includes("\r")).toBe(false);
    expect(sanitized.includes("\n")).toBe(false);
    expect(sanitized.includes("\t")).toBe(false);
    expect(sanitized.includes("\u0007")).toBe(false);
    expect(sanitized.includes("\u202E")).toBe(false);
    expect(sanitized.normalize("NFC")).toBe(sanitized);
  });

  test("empty sanitized title is distinguishable", () => {
    expect(sanitizeNotificationText("\u0007\u0008").length).toBe(0);
  });
});

describe("snapshot constants", () => {
  test("verbose TTY is color-only", () => {
    expect(RENDERER_CAPABILITIES_VERBOSE_TTY).toEqual({
      color: true,
      interactive: false,
      animation: false,
      notifications: false,
    });
  });
});
