import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { openLandoRuntime } from "@lando/core";
import { ProviderId } from "@lando/core/schema";
import { ProxyService, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { TestProxyService } from "@lando/sdk/test";

const providerLayers = [
  Layer.succeed(RuntimeProvider, TestRuntimeProvider),
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
  }),
  Layer.succeed(ProxyService, TestProxyService),
];

test("App.rebuild delegates to the rebuild lifecycle and runs pre/post rebuild events", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-app-handle-rebuild-"));
  const marker = join(root, "rebuild-events.txt");
  const originalCwd = process.cwd();
  await Bun.write(
    join(root, ".lando.yml"),
    `name: embedded-rebuild
runtime: 4
provider: ${TestRuntimeProvider.id}
services:
  cache:
    type: redis
    primary: true
events:
  pre-rebuild:
    - cmd: printf pre-rebuild >> ${marker}
      service: :host
  post-rebuild:
    - cmd: printf post-rebuild >> ${marker}
      service: :host
`,
  );
  process.chdir(root);

  try {
    // When
    await Effect.runPromise(
      Effect.scoped(
        openLandoRuntime({ plugins: { policy: "bundled-only", layers: providerLayers } }).pipe(
          Effect.flatMap((runtime) => runtime.app()),
          Effect.flatMap((app) => app.rebuild()),
        ),
      ),
    );

    // Then
    expect(await readFile(marker, "utf8")).toBe("pre-rebuildpost-rebuild");
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("App.start runs initialization events through the captured runtime", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-app-handle-start-init-"));
  const marker = join(root, "init-events.txt");
  const originalCwd = process.cwd();
  await Bun.write(
    join(root, ".lando.yml"),
    `name: embedded-start
runtime: 4
provider: ${TestRuntimeProvider.id}
services:
  cache:
    type: redis
    primary: true
events:
  pre-init:
    - cmd: printf pre-init >> ${marker}
      service: :host
`,
  );
  process.chdir(root);

  try {
    // When
    await Effect.runPromise(
      Effect.scoped(
        openLandoRuntime({ plugins: { policy: "bundled-only", layers: providerLayers } }).pipe(
          Effect.flatMap((runtime) => runtime.app()),
          Effect.flatMap((app) => app.start()),
        ),
      ),
    );

    // Then
    expect(await readFile(marker, "utf8")).toBe("pre-init");
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
