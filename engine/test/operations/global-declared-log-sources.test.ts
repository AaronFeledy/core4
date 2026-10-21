import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, LogSourceId, ServiceName } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { readGlobalLandofile } from "../../src/operations/global-plan.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

test.each(["node:22", "compose"])("merges global declared logs before decoding (%s)", async (type) => {
  // Given a generated global service and an authored override for the same log source.
  const root = await mkdtemp(join(tmpdir(), "lando-global-declared-logs-"));
  const paths = {
    root: AbsolutePath.make(root),
    distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
    userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
  };
  const globalApp = GlobalAppService.of({
    id: "global",
    root: Effect.succeed(paths.root),
    paths: Effect.succeed(paths),
    ensureRoot: Effect.void,
    ensureUserLandofile: Effect.succeed({ path: paths.userLandofile, created: false }),
    ensureRunning: () => Effect.succeed([]),
    regenerateDist: () => Effect.succeed({ path: paths.distLandofile, status: "unchanged", serviceIds: [] }),
  });
  try {
    await Bun.write(
      paths.distLandofile,
      `services:\n  app:\n    type: ${type}\n    image: node:22\n    logs:\n      - path: /tmp/app.log\n        id: applog\n        stream: stdout\n        timestamps: true\n`,
    );
    await Bun.write(
      paths.userLandofile,
      "services:\n  app:\n    logs:\n      - path: /tmp/app.log\n        id: applog\n        label: global log\n",
    );

    // When the real global adapter composes its generated and authored layers.
    const loaded = await Effect.runPromise(
      readGlobalLandofile().pipe(
        Effect.provide(Layer.merge(BunFileSystem.layer, Layer.succeed(GlobalAppService, globalApp))),
      ),
    );

    // Then omitted override fields retain authored values rather than decoding defaults early.
    expect(loaded.materialized).toBe(true);
    if (!loaded.materialized) throw new Error("Expected a materialized global Landofile");
    expect(loaded.landofile.services?.[ServiceName.make("app")]?.logs).toEqual([
      {
        id: LogSourceId.make("applog"),
        path: AbsolutePath.make("/tmp/app.log"),
        label: "global log",
        stream: "stdout",
        strategy: "follow",
        required: false,
        timestamps: true,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
