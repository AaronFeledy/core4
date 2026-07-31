import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Option } from "effect";

import { CertificateAuthority, FileSyncEngine } from "@lando/sdk/services";

import { HostMaintenanceRegistry } from "../../src/runtime/host-maintenance.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("bootstrap plugin services", () => {
  test("app bootstrap provides the bundled certificate authority", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only" } }))),
    );

    const certificateAuthority = Context.getOption(context, CertificateAuthority);

    expect(Option.isSome(certificateAuthority)).toBe(true);
    if (Option.isSome(certificateAuthority)) expect(certificateAuthority.value.id).toBe("mkcert");
  });

  test("minimal bootstrap makes a disabled bundled certificate authority unavailable", async () => {
    // Given: bundled discovery with the mkcert plugin explicitly disabled.
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makeLandoRuntime({
            bootstrap: "minimal",
            plugins: { policy: "bundled-only", disable: ["@lando/ca-mkcert"] },
          }),
        ),
      ),
    );

    // When: the certificate-authority service is resolved from minimal bootstrap.
    const certificateAuthority = Context.getOption(context, CertificateAuthority);

    // Then: the disabled mkcert contribution resolves to the unavailable implementation.
    expect(Option.isSome(certificateAuthority)).toBe(true);
    if (Option.isSome(certificateAuthority)) expect(certificateAuthority.value.id).toBe("unavailable");
  });

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
