import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Option } from "effect";

import { FileSyncEngine } from "@lando/sdk/services";

import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("bootstrap plugin services", () => {
  test("app bootstrap provides file-sync resolver without an eager engine", async () => {
    // Given: the real app bootstrap layer with bundled plugin descriptors.
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only" } }))),
    );

    // When: resolver and engine tags are resolved from the built context.
    const fileSyncResolver = Context.getOption(context, FileSyncResolver);
    const fileSyncEngine = Context.getOption(context, FileSyncEngine);

    // Then: selection is lazy through the resolver; no eager FileSyncEngine layer.
    expect(Option.isSome(fileSyncResolver)).toBe(true);
    expect(Option.isNone(fileSyncEngine)).toBe(true);
    if (Option.isSome(fileSyncResolver)) {
      expect(fileSyncResolver.value.candidates.map(({ id }) => id)).toContain("mutagen");
      const selected = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "win32",
          bindMountPerformance: "slow",
          fileSyncTargets: "prepared-volume",
        }),
      );
      expect(selected?.id).toBe("mutagen");
      const native = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "linux",
          bindMountPerformance: "native",
        }),
      );
      expect(native).toBeUndefined();
      const passthrough = await Effect.runPromise(
        fileSyncResolver.value.select({
          platform: "linux",
          bindMountPerformance: "slow",
          defaultEngine: "passthrough",
        }),
      );
      expect(passthrough).toBeUndefined();
    }
  });

  test("minimal bootstrap exposes bundled host maintenance to teardown commands", async () => {
    // Given: the real minimal runtime used by apps:poweroff and meta:uninstall.
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "minimal" }))),
    );

    // When: the optional host-maintenance service is resolved.
    const registry = Context.getOption(context, HostMaintenanceRegistry);

    // Then: minimal-bootstrap commands receive the bundled maintainer registry.
    expect(Option.isSome(registry)).toBe(true);
    if (Option.isSome(registry)) {
      expect(registry.value.maintainers.map((maintainer) => maintainer.id)).toContain(
        "lando-runtime-service",
      );
    }
  });
});
