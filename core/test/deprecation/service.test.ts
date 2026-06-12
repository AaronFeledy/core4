import { describe, expect, test } from "bun:test";

import { DateTime, Deferred, Effect, Exit, Layer, Option, Queue, Stream } from "effect";

import { DeprecatedSurfaceError, DeprecationContradictionError } from "@lando/sdk/errors";
import type { DeprecationNotice } from "@lando/sdk/schema";
import { DeprecationService, EventService, PluginRegistry, Telemetry } from "@lando/sdk/services";
import { DeprecationPluginRegistryLive } from "../../src/deprecation/plugin-registry.ts";
import { DeprecationServiceLive } from "../../src/deprecation/service.ts";
import { DeprecationTelemetryLive } from "../../src/deprecation/telemetry.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const warningNotice: DeprecationNotice = {
  since: "4.1.0",
  severity: "warn",
  note: "Use app:up instead.",
};

const errorNotice: DeprecationNotice = {
  since: "4.1.0",
  severity: "error",
  note: "This surface is no longer available.",
};

const timestamp = DateTime.unsafeMake("2026-06-11T16:00:00.000Z");
const DeprecationServiceWithEventsLive = DeprecationServiceLive.pipe(Layer.provide(EventServiceLive));

describe("DeprecationServiceLive", () => {
  test("publishes deprecation-used after recording usage", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deprecations = yield* DeprecationService;
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          yield* deprecations.use({ kind: "command", id: "app:start", notice: warningNotice, timestamp });
          const event = yield* Queue.take(queue);
          return {
            event,
            summary: yield* deprecations.summary(),
          };
        }),
      ).pipe(Effect.provide(Layer.mergeAll(EventServiceLive, DeprecationServiceWithEventsLive))),
    );

    expect(result.event._tag).toBe("deprecation-used");
    expect(result.event.use.id).toBe("app:start");
    expect(result.summary[0]?.id).toBe("app:start");
    expect(result.summary[0]?.count).toBe(1);
  });

  test("publishes deprecation-used before failing severity:error usage", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deprecations = yield* DeprecationService;
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const exit = yield* Effect.exit(
            deprecations.use({ kind: "command", id: "app:legacy", notice: errorNotice, timestamp }),
          );
          const eventsAfterFailure = yield* Queue.takeAll(queue);
          return {
            exit,
            events: Array.from(eventsAfterFailure),
            summary: yield* deprecations.summary(),
          };
        }),
      ).pipe(Effect.provide(Layer.mergeAll(EventServiceLive, DeprecationServiceWithEventsLive))),
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.events[0]?._tag).toBe("deprecation-used");
    expect(result.events[0]?.use.id).toBe("app:legacy");
    expect(result.summary[0]?.id).toBe("app:legacy");
    expect(result.summary[0]?.count).toBe(1);
  });

  test("does not abort use when a deprecation-used subscriber fails", async () => {
    const summary = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deprecations = yield* DeprecationService;
          const events = yield* EventService;
          yield* events.subscribe("deprecation-used").pipe(
            Stream.runForEach(() => Effect.fail(new Error("subscriber failed"))),
            Effect.fork,
          );
          yield* deprecations.use({ kind: "command", id: "app:start", notice: warningNotice, timestamp });
          return yield* deprecations.summary();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(EventServiceLive, DeprecationServiceWithEventsLive))),
    );

    expect(summary[0]?.id).toBe("app:start");
    expect(summary[0]?.count).toBe(1);
  });

  test("telemetry consumes deprecation-used through the event bus", async () => {
    const recorded: Array<{ readonly event: string; readonly data: Readonly<Record<string, unknown>> }> = [];
    const recordedOnce = Deferred.unsafeMake<void>();
    const telemetry = {
      enabled: true,
      record: (event: string, data: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => {
          recorded.push({ event, data });
        }).pipe(Effect.zipRight(Deferred.succeed(recordedOnce, undefined))),
    };
    const telemetryDeps = Layer.mergeAll(EventServiceLive, Layer.succeed(Telemetry, telemetry));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deprecations = yield* DeprecationService;
          yield* deprecations.use({ kind: "command", id: "app:start", notice: warningNotice, timestamp });
          yield* Deferred.await(recordedOnce);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            telemetryDeps,
            DeprecationServiceLive.pipe(Layer.provide(telemetryDeps)),
            DeprecationTelemetryLive.pipe(Layer.provide(telemetryDeps)),
          ),
        ),
      ),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.event).toBe("deprecation-used");
    expect((recorded[0]?.data.use as { id?: string } | undefined)?.id).toBe("app:start");
  });

  test("registers, looks up, records use, and retains repeated-use counts", async () => {
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* DeprecationService;
        yield* service.register("core", "command", "app:start", warningNotice);
        const lookedUp = yield* service.lookup("command", "app:start");
        yield* service.use({ kind: "command", id: "app:start", notice: warningNotice, timestamp });
        yield* service.use({ kind: "command", id: "app:start", notice: warningNotice, timestamp });
        return {
          lookedUp,
          summary: yield* service.summary(),
        };
      }).pipe(Effect.provide(DeprecationServiceLive)),
    );

    expect(Option.isSome(summary.lookedUp)).toBe(true);
    expect(summary.summary).toHaveLength(1);
    expect(summary.summary[0]?.kind).toBe("command");
    expect(summary.summary[0]?.id).toBe("app:start");
    expect(summary.summary[0]?.count).toBe(2);
  });

  test("fails use of severity:error surfaces with DeprecatedSurfaceError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* DeprecationService;
        yield* service.use({ kind: "command", id: "app:legacy", notice: errorNotice, timestamp });
      }).pipe(Effect.provide(DeprecationServiceLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(DeprecatedSurfaceError);
    }
  });

  test("rejects a non-deprecated alias pointing at a deprecated canonical surface", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* DeprecationService;
        yield* service.register("core", "command", "app:start", warningNotice);
        yield* service.registerAlias("core", "command", "app:start", "start");
      }).pipe(Effect.provide(DeprecationServiceLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(DeprecationContradictionError);
    }
  });

  test("plugins bootstrap layer provides a populated deprecation registry", async () => {
    const pluginNotice: DeprecationNotice = {
      since: "4.1.0",
      severity: "warn",
      note: "Use @lando/new-plugin.",
    };

    const pluginRegistry = {
      list: Effect.succeed([
        {
          name: "@lando/legacy-plugin",
          version: "1.0.0",
          api: 4,
          deprecated: pluginNotice,
        },
      ]),
      load: () => Effect.die("not used"),
      loadServiceType: () => Effect.die("not used"),
    };
    const deps = Layer.mergeAll(DeprecationServiceLive, Layer.succeed(PluginRegistry, pluginRegistry));

    const lookup = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* DeprecationService;
        return yield* service.lookup("plugin", "@lando/legacy-plugin");
      }).pipe(Effect.provide(Layer.mergeAll(deps, DeprecationPluginRegistryLive.pipe(Layer.provide(deps))))),
    );

    expect(Option.isSome(lookup)).toBe(true);
  });
});
