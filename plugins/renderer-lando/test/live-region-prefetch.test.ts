import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { CliCommandInitEvent, type LandoEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import type { RendererIO } from "@lando/sdk/renderer";
import { EventService } from "@lando/sdk/services";

import { EventServiceLive, createBufferedRendererIO } from "@lando/core/testing";

import {
  type LiveRegionControllerOptions,
  createLiveRegionController,
} from "../src/opentui/live-region-controller.ts";
import {
  acquireLiveRegionSubstrate,
  prefetchLiveRegionModule,
  resetLiveRegionModuleCacheForTests,
} from "../src/opentui/live-region-substrate.ts";
import {
  getOpenTuiSubstrateAvailability,
  resetOpenTuiSubstrateAvailabilityForTests,
} from "../src/opentui/substrate-availability.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { makeLiveRegionFixture } from "./live-region-test-kit.ts";

const ts = "2026-05-19T12:00:00.000Z";

const cliInit = (commandId: string, invocationId: string, parentInvocationId?: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandInitEvent)({
    _tag: `cli-${commandId}-init`,
    commandId,
    argv: [commandId],
    args: {},
    flags: {},
    cwd: "/tmp",
    invocationId,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    timestamp: ts,
  });

const treeStart = (parentId: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label: parentId,
    children,
    timestamp: ts,
  });

const ttyIo = (): { readonly io: RendererIO } => {
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  return { io: { ...io, externalOutputStream: process.stdout } };
};

const substrateOptions: LiveRegionControllerOptions = {
  stdout: process.stdout,
  width: 80,
  height: 24,
};

const resetLiveRegionState = (): void => {
  resetLiveRegionModuleCacheForTests();
  resetOpenTuiSubstrateAvailabilityForTests();
};

beforeEach(resetLiveRegionState);
afterEach(resetLiveRegionState);

describe("live-region module prefetch", () => {
  test("later acquire reuses the same loadModule promise started by prefetch", async () => {
    const fixture = makeLiveRegionFixture();
    let loadCalls = 0;
    let createRendererCalls = 0;
    const modulePromise = Promise.resolve(fixture.module);
    const loadModule = () => {
      loadCalls += 1;
      return modulePromise;
    };
    const createRenderer = async () => {
      createRendererCalls += 1;
      return fixture.renderer;
    };

    prefetchLiveRegionModule(loadModule);

    expect(loadCalls).toBe(1);
    expect(createRendererCalls).toBe(0);

    const first = await acquireLiveRegionSubstrate(substrateOptions, { loadModule, createRenderer });
    const second = await acquireLiveRegionSubstrate(substrateOptions, { loadModule, createRenderer });

    expect(loadCalls).toBe(1);
    expect(first.module).toBe(fixture.module);
    expect(second.module).toBe(first.module);
    expect(createRendererCalls).toBe(2);
  });

  test("rejected prefetch is observed and records substrate failure", async () => {
    const cause = new Error("native module missing");
    const loadModule = () => Promise.reject(cause);

    prefetchLiveRegionModule(loadModule);
    await Promise.resolve();

    expect(getOpenTuiSubstrateAvailability()).toEqual({ available: false, cause });
  });
});

describe("TTY consumer live-region prefetch", () => {
  const drive = (
    io: RendererIO,
    loadModule: () => Promise<ReturnType<typeof makeLiveRegionFixture>["module"]>,
    createRenderer: () => Promise<ReturnType<typeof makeLiveRegionFixture>["renderer"]>,
    events: ReadonlyArray<LandoEvent>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const svc = yield* EventService;
        for (const event of events) yield* svc.publish(event);
        yield* Effect.sleep("20 millis");
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            makeLandoEventConsumer(io, {
              loadModule,
              createLiveRegion: (options) =>
                createLiveRegionController(options, { loadModule, createRenderer }),
            }),
            EventServiceLive,
          ),
        ),
      ),
    );

  test("outer init starts loadModule without creating a renderer for prompt-first commands", async () => {
    const { io } = ttyIo();
    const fixture = makeLiveRegionFixture();
    let loadCalls = 0;
    let createRendererCalls = 0;
    const pending = Promise.withResolvers<typeof fixture.module>();
    const loadModule = () => {
      loadCalls += 1;
      return pending.promise;
    };
    const createRenderer = async () => {
      createRendererCalls += 1;
      return fixture.renderer;
    };

    await Effect.runPromise(drive(io, loadModule, createRenderer, [cliInit("apps:init", "inv-1")]));

    expect(loadCalls).toBe(1);
    expect(createRendererCalls).toBe(0);
    pending.resolve(fixture.module);
  });

  test("later acquire after prompt-first init reuses the same loadModule call", async () => {
    const { io } = ttyIo();
    const fixture = makeLiveRegionFixture();
    let loadCalls = 0;
    let createRendererCalls = 0;
    const modulePromise = Promise.resolve(fixture.module);
    const loadModule = () => {
      loadCalls += 1;
      return modulePromise;
    };
    const createRenderer = async () => {
      createRendererCalls += 1;
      return fixture.renderer;
    };

    await Effect.runPromise(
      drive(io, loadModule, createRenderer, [cliInit("apps:init", "inv-1"), treeStart("proxy", ["traefik"])]),
    );

    expect(loadCalls).toBe(1);
    expect(createRendererCalls).toBe(0);
  });

  test("nested init does not start another import", async () => {
    const { io } = ttyIo();
    const fixture = makeLiveRegionFixture();
    let loadCalls = 0;
    const loadModule = () => {
      loadCalls += 1;
      return Promise.resolve(fixture.module);
    };
    const createRenderer = async () => fixture.renderer;

    await Effect.runPromise(
      drive(io, loadModule, createRenderer, [
        cliInit("apps:init", "inv-1"),
        cliInit("app:start", "inv-2", "inv-1"),
      ]),
    );

    expect(loadCalls).toBe(1);
  });
});
