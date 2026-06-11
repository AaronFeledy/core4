import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Exit, Layer, Option } from "effect";

import { DeprecatedSurfaceError, DeprecationContradictionError } from "@lando/sdk/errors";
import type { DeprecationNotice } from "@lando/sdk/schema";
import { DeprecationService, PluginRegistry } from "@lando/sdk/services";
import { DeprecationPluginRegistryLive } from "../../src/deprecation/plugin-registry.ts";
import { DeprecationServiceLive } from "../../src/deprecation/service.ts";

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

describe("DeprecationServiceLive", () => {
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
