import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Exit, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const plan = async (service: Record<string, unknown>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-mounts-"));
  try {
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "commandapp",
      runtime: 4,
      services: { web: { image: "alpine", home: false, ...service } },
    });
    const layer = AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          BunFileSystem.layer,
          Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", home: root, env: {} })),
        ),
      ),
    );
    return await Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(document, root), TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  [{ mounts: ["./bin:/usr/local/bin/xdg-open"] }, ["services", "web", "mounts", 0], "xdg-open"],
  [{ storage: ["/usr/local/bin/lando"] }, ["services", "web", "storage", 0], "lando"],
  [{ tmpfs: ["/usr/local//bin/open/"] }, ["services", "web", "tmpfs", 0], "open"],
  [{ volumes: ["./bin:/usr/local/bin/open"] }, ["services", "web", "volumes", 0], "open"],
] as const)("planning refuses %j on a host-proxy service", async (mounts, path, command) => {
  // Given a Lando-based service, which gets host-proxy, with a mount at one of its command paths.
  // When it is planned.
  const exit = await plan(mounts);
  // Then planning fails at that entry and says Lando provides the command there.
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const error = exit.cause.reasons[0];
    expect(error?._tag === "Fail" ? error.error : undefined).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [
        {
          path,
          message: expect.stringContaining(`reserved for Lando's ${command} command`),
          suggestion: expect.stringContaining(
            `Lando provides the ${command} command at /usr/local/bin/${command}`,
          ),
        },
      ],
    });
  }
});

test("planning keeps an exact host-proxy command mount on a compose service, which gets no host-proxy", async () => {
  // Given a compose service, which carries no host-proxy feature.
  // When it mounts a file at /usr/local/bin/xdg-open.
  const exit = await plan({ type: "compose", mounts: ["./bin:/usr/local/bin/xdg-open"] });
  // Then the mount is its own.
  expect(Exit.isSuccess(exit)).toBe(true);
});
