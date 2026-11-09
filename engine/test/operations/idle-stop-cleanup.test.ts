import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, appIdentityKey } from "@lando/sdk/schema";
import { PathsService, RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { globalStop } from "../../src/operations/global-stop.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test.each(["user", "global"] as const)(
  "%s idle stop cleans host workers after route withdrawal fails and retains the failure",
  async (kind) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-idle-stop-cleanup-")));
    try {
      const paths = makeLandoPaths({ userDataRoot: base, env: {}, platform: "linux" });
      const root = AbsolutePath.make(kind === "global" ? paths.globalAppRoot : join(base, "app"));
      await mkdir(root);
      const applied =
        kind === "global"
          ? globalPlanAt(root)
          : { ...plan, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } };
      const app = { kind, id: applied.id, root };
      const directories = [
        paths.hostProxyRunDir(app.id, root),
        paths.agentRelayRunDir("ssh", app.id, root),
        paths.agentRelayRunDir("gpg", app.id, root),
      ];
      for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "credentials"), "stale", { mode: 0o600 });
      }
      const failure = new ProxyError({
        proxyId: "test",
        message: "route withdrawal failed",
        remediation: "Repair route storage.",
      });
      const router = {
        ...makeTestRouterService(),
        removeRoutes: () => Effect.fail(failure),
      };
      const work =
        kind === "global"
          ? globalStop().pipe(
              Effect.provideService(RouterService, router),
              Effect.provideService(PathsService, paths),
              Effect.provide(
                (
                  await globalTeardownHarness(base, {
                    plan: applied,
                    status: Effect.succeed({ state: "idle" }),
                  })
                ).layer,
              ),
              Effect.asVoid,
            )
          : stopAppForTarget({}, { plan: applied, root, app }).pipe(
              Effect.provideService(RouterService, router),
              Effect.provideService(PathsService, paths),
              Effect.provide(
                makeHarness({
                  plannedApp: applied,
                  appliedPlans: [applied],
                  providerOverrides: {
                    getStatus: Effect.succeed({ state: "idle" }),
                    ensureReady: Effect.die("idle stop must not start the runtime"),
                    list: () => Effect.die("idle stop must not list the runtime"),
                  },
                }).layer,
              ),
              Effect.asVoid,
            );

      const result = await Effect.runPromise(work.pipe(Effect.provide(BunFileSystem.layer), Effect.result));

      expect(result).toMatchObject({ _tag: "Failure", failure });
      for (const directory of directories)
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
