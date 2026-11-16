import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTraefikRouterService } from "@lando/proxy-traefik";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem, RouterService } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Effect } from "effect";
import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { globalStop } from "../../src/operations/global-stop.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { makeRouterStateStore } from "../subsystems/proxy/router-state-fixture.ts";

test.each([false, true])(
  "global:stop withdraws only its owner and preserves router state with applied plan=%s",
  async (applied) => {
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-global-router-cleanup-")));
    try {
      const root = AbsolutePath.make(join(dataRoot, "global"));
      const directory = join(root, "proxy-traefik", "dynamic");
      const plan = globalPlanAt(root);
      const owner = routeOwnerFromPlan(plan);
      const globalFile = `routes-${owner.ownerKey}.yml`;
      const preserved = new Map([
        ["routes-old.yml", "legacy routes"],
        [`routes-${"a".repeat(64)}.yml`, '# lando-route-file: {"version":1,"app":"user-app"}\nhttp:\n'],
        [".lando-port-acquisition.json", '{"httpPort":18080,"httpsPort":18443}\n'],
        [".lando-default-domain", "custom.test\n"],
        ["tls-default.yml", "shared TLS configuration"],
        ["dashboard.yml", "shared dashboard configuration"],
        ["fallback.yml", "shared fallback configuration"],
        ["custom.yml", "unrelated config"],
      ]);
      await mkdir(directory, { recursive: true });
      for (const [file, content] of preserved) await writeFile(join(directory, file), content);
      await writeFile(
        join(directory, globalFile),
        '# lando-route-file: {"version":1,"app":"global"}\nhttp:\n',
      );
      const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(BunFileSystem.layer)));
      const router = makeTraefikRouterService({
        stateStore: makeRouterStateStore(),
        paths: { platform: "linux", globalAppRoot: root },
        certificateAuthority: makeTestCertificateAuthority(),
        fileSystem: { ...fileSystem, writeSecretAtomic: fileSystem.writeAtomic },
        globalApp: { ensureRunning: () => Effect.die("stop must not start the router") },
      });
      const harness = await globalTeardownHarness(dataRoot, applied ? { plan } : {});

      await Effect.runPromise(
        globalStop().pipe(Effect.provideService(RouterService, router), Effect.provide(harness.layer)),
      );

      expect((await readdir(directory)).toSorted()).toEqual([...preserved.keys()].toSorted());
      for (const [file, content] of preserved)
        expect(await readFile(join(directory, file), "utf8")).toBe(content);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
);
