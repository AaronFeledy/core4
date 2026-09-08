import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Option } from "effect";

import { FileSyncEngine } from "@lando/sdk/services";

import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("bootstrap plugin services", () => {
  test("app bootstrap provides file sync from bundled plugin descriptors", async () => {
    // Given: the real app bootstrap layer with bundled plugin descriptors.
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "app" }))),
    );

    // When: the file-sync service is resolved from the built context.
    const fileSyncEngine = Context.getOption(context, FileSyncEngine);

    // Then: the descriptor-provided Mutagen engine remains available.
    expect(Option.isSome(fileSyncEngine)).toBe(true);
    if (Option.isSome(fileSyncEngine)) expect(fileSyncEngine.value.id).toBe("mutagen");
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
