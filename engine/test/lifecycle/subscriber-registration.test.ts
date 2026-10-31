import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeLandoPaths } from "@lando/paths";
import { CliCommandRunEvent, type LandoEvent } from "@lando/sdk/events";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import {
  CommandRegistry,
  ConfigService,
  EventService,
  Logger,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  StateStore,
} from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

import { layer as subscriberLayer } from "../../src/lifecycle/subscribers.ts";
import { EventDispatchControl, type EventDispatchRegistration } from "../../src/services/event-service.ts";

const unused = Effect.die("unused subscriber registration dependency");

const privateFileAccess: PrivateFileAccess = {
  enforce: () => Promise.resolve(),
  verify: () => Promise.resolve(),
};

const httpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
);

const logger = Logger.of({
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
});

const events = EventService.of({
  publish: () => Effect.void,
  subscribe: () => Stream.empty,
  subscribeQueue: unused,
  waitFor: () => unused,
  subscribeWithHistory: () => Effect.never,
  waitForAny: () => unused,
  query: () => Effect.succeed([]),
});

const managedFiles = ManagedFileService.of({
  plan: () => unused,
  apply: () => unused,
  remove: () => unused,
  status: unused,
  adopt: () => unused,
  release: () => unused,
});

const stateStore = StateStore.of({
  open: () => unused,
  withLock: () => unused,
});

const redaction = RedactionService.of({
  registerValues: () => Effect.void,
  payloadValues: () => unused,
  forProfile: () => unused,
});

const terminalEvent = (commandId: string): LandoEvent =>
  Schema.decodeUnknownSync(CliCommandRunEvent)({
    _tag: `cli-${commandId}-run`,
    commandId,
    argv: [],
    args: {},
    flags: {},
    cwd: "/app",
    invocationId: "invocation",
    timestamp: "2026-07-18T00:00:00.000Z",
    durationMs: 1,
    exitCode: 0,
  });

const registration = (input: {
  readonly selector: Record<string, unknown>;
  readonly lists: { current: number };
  readonly loads: { current: number };
  readonly calls: { current: number };
  readonly installed: { current: EventDispatchRegistration | undefined };
}) => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/subscriber-registration",
    version: "1.0.0",
    api: 4,
    subscribers: [{ id: "marker", selectors: [input.selector], module: "./marker.ts" }],
  });
  const pluginModule = {
    name: String(manifest.name),
    manifest,
    subscriberFactoryLoaders: new Map([
      [
        "marker",
        () => {
          input.loads.current += 1;
          return Promise.resolve(
            () => () =>
              Effect.sync(() => {
                input.calls.current += 1;
              }),
          );
        },
      ],
    ]),
  } satisfies LandoPluginModule;
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([manifest]),
        load: () => unused,
        loadServiceType: () => unused,
        loadServiceFeature: () => unused,
        loadAppFeature: () => unused,
      }),
    ),
    Layer.succeed(ConfigService, ConfigService.of({ load: unused, get: () => unused })),
    Layer.succeed(EventService, events),
    Layer.succeed(Logger, logger),
    Layer.succeed(ManagedFileService, managedFiles),
    Layer.succeed(StateStore, stateStore),
    Layer.succeed(
      PathsService,
      PathsService.of(makeLandoPaths({ userDataRoot: "/tmp/lando-subscriber-registration" })),
    ),
    Layer.succeed(RedactionService, redaction),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(
      CommandRegistry,
      CommandRegistry.of({
        list: Effect.sync(() => {
          input.lists.current += 1;
          return [];
        }),
      }),
    ),
    Layer.succeed(
      EventDispatchControl,
      EventDispatchControl.of({
        install: (next) =>
          Effect.sync(() => {
            input.installed.current = next;
          }),
      }),
    ),
  );
  return subscriberLayer(privateFileAccess, [pluginModule], ["meta:version"]).pipe(
    Layer.provide(dependencies),
  );
};

describe("metadata-only subscriber registration", () => {
  test("does not list commands while a terminal family delivers a newly seen app id", async () => {
    // Given: a family subscriber and a command registry whose list would record app discovery.
    const lists = { current: 0 };
    const loads = { current: 0 };
    const calls = { current: 0 };
    const installed: { current: EventDispatchRegistration | undefined } = { current: undefined };
    const layer = registration({
      selector: { family: "cli-command-terminal" },
      lists,
      loads,
      calls,
      installed,
    });

    // When: registration finishes and a previously unseen app command emits run.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          expect(lists.current).toBe(0);
          expect(loads.current).toBe(0);
          const dispatch = installed.current;
          expect(dispatch).toBeDefined();
          if (dispatch === undefined) return;
          expect(dispatch.hasSubscribers("cli-app:newly-seen-init")).toBe(false);
          expect(dispatch.hasSubscribers("cli-app:newly-seen-run")).toBe(true);
          yield* dispatch.dispatch(terminalEvent("app:newly-seen"));
          expect(loads.current).toBe(1);
          expect(calls.current).toBe(1);
          yield* dispatch.dispatch(terminalEvent("app:newly-seen"));
        }),
      ),
    );

    // Then: the factory stayed cached and command listing never ran.
    expect(lists.current).toBe(0);
    expect(loads.current).toBe(1);
    expect(calls.current).toBe(2);
  });

  test("matches a deferred exact app selector only for its real invocation", async () => {
    // Given: an exact selector for an app command absent from static metadata.
    const lists = { current: 0 };
    const loads = { current: 0 };
    const calls = { current: 0 };
    const installed: { current: EventDispatchRegistration | undefined } = { current: undefined };
    const layer = registration({
      selector: { event: "cli-app:unseen-script-run" },
      lists,
      loads,
      calls,
      installed,
    });

    // When: registration closes and two app terminal events are dispatched.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          const dispatch = installed.current;
          expect(dispatch).toBeDefined();
          if (dispatch === undefined) return;
          expect(dispatch.hasSubscribers("cli-app:other-script-run")).toBe(false);
          expect(dispatch.hasSubscribers("cli-app:unseen-script-run")).toBe(true);
          yield* dispatch.dispatch(terminalEvent("app:other-script"));
          yield* dispatch.dispatch(terminalEvent("app:unseen-script"));
        }),
      ),
    );

    // Then: discovery did not run, and only the deferred invocation loaded the handler.
    expect(lists.current).toBe(0);
    expect(loads.current).toBe(1);
    expect(calls.current).toBe(1);
  });
});
