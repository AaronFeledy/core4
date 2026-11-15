import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { makeTraefikRouterService } from "@lando/proxy-traefik";
import { ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, appIdentityKey } from "@lando/sdk/schema";
import { FileSystem, PathsService, RouterService } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect } from "effect";
import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { resolveTeardownEvidence } from "../../src/providers/applied-state-resolution.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeRouterStateStore } from "../subsystems/proxy/router-state-fixture.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test.each([
  ["applied", false],
  ["owned", false],
  ["absent", false],
  ["owned", true],
  ["absent", true],
] as const)(
  "idle stop cleans only its host state with %s evidence and route failure=%s",
  async (kind, routeFailure) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-idle-stop-evidence-")));
    try {
      const paths = makeLandoPaths({ userDataRoot: base, env: {}, platform: "linux" });
      const root = AbsolutePath.make(join(base, "app"));
      await mkdir(root);
      const desired = { ...plan, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } };
      const app = { kind: "user" as const, id: desired.id, root };
      const ownership = {
        appRoot: root,
        ownerKey: desired.identity.ownerKey,
        providerId: desired.provider,
        appIds: [desired.id],
      };
      const provider = {
        ...TestRuntimeProvider,
        id: "lando",
        isAvailable: Effect.succeed(true),
        canCleanupOwnedResources: Effect.succeed(true),
        appliedPlans: Effect.succeed(kind === "applied" ? [desired] : []),
        runtimeOnline: Effect.succeed(false),
        getStatus: Effect.succeed({ state: "idle" as const }),
        ensureReady: Effect.die("stop must not launch the runtime"),
        list: () => Effect.die("stop must not list an idle runtime"),
        listVolumes: () => Effect.die("stop must not list idle runtime volumes"),
        resourceOwnership: () => Effect.succeed(kind === "absent" ? undefined : ownership),
        cleanupOwnedResources: () => Effect.die("stop must not clean idle runtime resources"),
        destroy: () => Effect.die("stop must not destroy idle runtime resources"),
        removeObservedService: () => Effect.die("stop must not remove idle orphan containers"),
      };
      const harness = makeHarness({
        plannedApp: desired,
        appliedPlans: kind === "applied" ? [desired] : [],
        selectProvider: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed(kind === "applied" ? desired : undefined),
        resolveTeardownEvidence: (root, app) => resolveTeardownEvidence(root, [provider], app),
      });
      const directories = [
        paths.hostProxyRunDir(app.id, root),
        paths.agentRelayRunDir("ssh", app.id, root),
        paths.agentRelayRunDir("gpg", app.id, root),
      ];
      for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "credentials"), "stale", { mode: 0o600 });
      }
      const foreign = paths.hostProxyRunDir(app.id, AbsolutePath.make(join(base, "other-app")));
      await mkdir(foreign, { recursive: true, mode: 0o700 });
      await writeFile(join(foreign, "credentials"), "preserved", { mode: 0o600 });
      const routeDirectory = join(paths.globalAppRoot, "proxy-traefik", "dynamic");
      await mkdir(routeDirectory, { recursive: true });
      const route = `routes-${routeOwnerFromPlan(desired).ownerKey}.yml`;
      const foreignRoute = `routes-${appIdentityKey("owner", foreign)}.yml`;
      await writeFile(
        join(routeDirectory, route),
        `# lando-route-file: {"version":1,"app":"${app.id}"}\nhttp:\n`,
      );
      await writeFile(
        join(routeDirectory, foreignRoute),
        '# lando-route-file: {"version":1,"app":"other"}\nhttp:\n',
      );
      const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));
      const router = makeTraefikRouterService({
        stateStore: makeRouterStateStore(),
        paths: { platform: "linux", globalAppRoot: paths.globalAppRoot },
        certificateAuthority: makeTestCertificateAuthority(),
        fileSystem: { ...fileSystem, writeSecretAtomic: fileSystem.writeAtomic },
        globalApp: { ensureRunning: () => Effect.die("stop must not launch the router") },
      });
      const failure = new ProxyError({
        proxyId: router.id,
        message: "Route withdrawal failed.",
        remediation: "Repair route storage.",
      });

      const result = await Effect.runPromise(
        stopAppForTarget(
          {},
          {
            plan: desired,
            root,
            app,
            landofile: literalTestLandofile({ name: desired.name, services: {} }, root),
          },
        ).pipe(
          Effect.provideService(
            RouterService,
            routeFailure ? { ...router, removeRoutes: () => Effect.fail(failure) } : router,
          ),
          Effect.provideService(PathsService, paths),
          Effect.provide(harness.layer),
          Effect.provide(BunFileSystem.layer),
          Effect.result,
        ),
      );

      expect(result).toMatchObject(
        routeFailure
          ? { _tag: "Failure", failure }
          : {
              _tag: "Success",
              success: {
                outcome: kind === "applied" ? "stopped" : "unchanged",
                servicesStopped: [],
              },
            },
      );
      expect((await readdir(routeDirectory)).toSorted()).toEqual(
        (routeFailure ? [route, foreignRoute] : [foreignRoute]).toSorted(),
      );
      for (const directory of directories)
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await Bun.file(join(foreign, "credentials")).text()).toBe("preserved");
      expect(
        harness.events
          .filter(({ _tag }) => _tag === "pre-stop" || _tag === "post-stop")
          .map(({ _tag }) => _tag),
      ).toEqual(kind === "applied" ? ["pre-stop", "post-stop"] : []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
