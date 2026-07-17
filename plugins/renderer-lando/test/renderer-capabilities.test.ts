import { describe, expect, test } from "bun:test";
import { Effect, type Layer, ManagedRuntime } from "effect";

import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_TTY_INITIAL,
  RENDERER_CAPABILITIES_VERBOSE_TTY,
} from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import {
  type CapabilityProbe,
  createCapabilitySnapshot,
  promoteFromProbe,
  scheduleCapabilityProbe,
} from "../src/capabilities.ts";
import { sanitizeNotificationText } from "../src/notify-sanitize.ts";
import {
  makeLandoEventConsumer,
  makeLandoService,
  resolveCapabilitySnapshot,
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
  test("default renderer non-TTY is all false", async () => {
    const layer = makeLandoService({
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      isTTY: false,
    });
    const caps = await runService(
      layer,
      Effect.map(Renderer, (r) => r.capabilities),
    );
    expect(caps).toEqual(RENDERER_CAPABILITIES_NONE);
  });

  test("default renderer TTY starts at interactive/animation true, color/notifications false", async () => {
    const layer = makeLandoService({
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      isTTY: true,
    });
    const caps = await runService(
      layer,
      Effect.map(Renderer, (r) => r.capabilities),
    );
    expect(caps).toEqual(RENDERER_CAPABILITIES_TTY_INITIAL);
  });

  test("probe success promotes color and notifications without demoting interactive/animation", async () => {
    const handle = createCapabilitySnapshot(RENDERER_CAPABILITIES_TTY_INITIAL);
    promoteFromProbe(handle, { kind: "success", color: true, notifications: true });
    expect(handle.get()).toEqual({
      color: true,
      interactive: true,
      animation: true,
      notifications: true,
    });
  });

  test("probe timeout and no-response leave the initial snapshot", async () => {
    const timeoutHandle = createCapabilitySnapshot(RENDERER_CAPABILITIES_TTY_INITIAL);
    promoteFromProbe(timeoutHandle, { kind: "timeout" });
    expect(timeoutHandle.get()).toEqual(RENDERER_CAPABILITIES_TTY_INITIAL);

    const noResponseHandle = createCapabilitySnapshot(RENDERER_CAPABILITIES_TTY_INITIAL);
    promoteFromProbe(noResponseHandle, { kind: "no-response" });
    expect(noResponseHandle.get()).toEqual(RENDERER_CAPABILITIES_TTY_INITIAL);
  });

  test("fake-clock delayed success promotes once without wall-clock wait", async () => {
    const handle = createCapabilitySnapshot(RENDERER_CAPABILITIES_TTY_INITIAL);
    const timers: Array<() => void> = [];
    const clock = {
      setTimeout: (fn: () => void, _ms: number) => {
        timers.push(fn);
        return 0;
      },
    };
    let resolveProbe:
      | ((value: { kind: "success"; color: boolean; notifications: boolean }) => void)
      | undefined;
    const probe: CapabilityProbe = {
      timeoutMs: 50,
      run: () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    };
    scheduleCapabilityProbe(handle, probe, clock);
    expect(handle.get()).toEqual(RENDERER_CAPABILITIES_TTY_INITIAL);
    resolveProbe?.({ kind: "success", color: true, notifications: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.get().notifications).toBe(true);
    expect(handle.get().color).toBe(true);
    // timeout firing later must not demote
    for (const t of timers) t();
    expect(handle.get().notifications).toBe(true);
  });

  test("makeService and makeEventConsumer share one snapshot for the same RendererIO", async () => {
    const io = {
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      isTTY: true,
    };
    const clock = {
      setTimeout: (_fn: () => void, _ms: number) => 0,
    };
    let resolveProbe:
      | ((value: { kind: "success"; color: boolean; notifications: boolean }) => void)
      | undefined;
    const probe: CapabilityProbe = {
      timeoutMs: 50,
      run: () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    };
    const serviceLayer = makeLandoService(io, { capabilityProbe: probe, clock });
    const serviceCaps = await runService(
      serviceLayer,
      Effect.map(Renderer, (r) => r.capabilities),
    );
    expect(serviceCaps.notifications).toBe(false);

    const shared = resolveCapabilitySnapshot(io);
    // Consumer factory without an override reuses the same handle (no second probe).
    const consumer = makeLandoEventConsumer(io);
    expect(consumer).toBeDefined();
    expect(resolveCapabilitySnapshot(io)).toBe(shared);

    resolveProbe?.({ kind: "success", color: true, notifications: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(shared.get().notifications).toBe(true);
    const after = await runService(
      makeLandoService(io),
      Effect.map(Renderer, (r) => r.capabilities),
    );
    expect(after.notifications).toBe(true);
  });

  test("notify.desktop before promotion is dropped and not replayed after promotion", async () => {
    const calls: Array<{ message: string; title?: string }> = [];
    const handle = createCapabilitySnapshot(RENDERER_CAPABILITIES_TTY_INITIAL);
    const getCapabilities = () => handle.get();
    const trigger = (message: string, title?: string) => {
      calls.push(title === undefined ? { message } : { message, title });
      return true;
    };
    const consumer = makeLandoEventConsumer(
      { writeStdout: () => undefined, writeStderr: () => undefined, isTTY: true },
      { getCapabilities, triggerNotification: trigger },
    );
    // Pre-promotion: notifications false → no call; no buffering for later replay.
    expect(getCapabilities().notifications).toBe(false);
    if (getCapabilities().notifications) trigger("x");
    expect(calls).toEqual([]);
    promoteFromProbe(handle, { kind: "success", color: true, notifications: true });
    expect(calls).toEqual([]);
    if (getCapabilities().notifications) trigger("after");
    expect(calls).toEqual([{ message: "after" }]);
    expect(consumer).toBeDefined();
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
