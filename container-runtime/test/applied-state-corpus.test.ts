// Historical bytes written by origin/main 140f4828f, never regenerate these files.
// Each future state-version bump adds a new snapshot alongside this corpus.
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";

const fixtures = join(import.meta.dir, "fixtures/applied-state-v3");
const access = { enforce: async () => undefined, verify: async () => undefined };

// The historical plugin contributed both aliases via ServiceFeatureContext.addHostAlias.
// Main's authored hostnames validator rejected these spellings, but its plan schema did not.
for (const file of new Bun.Glob("**/*.json").scanSync(fixtures)) {
  test(`reads historical ${file} through the applied-state store`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-state-corpus-"));
    const record = file.endsWith("applied-plans.json");
    const target = join(root, record ? "applied-plans.json" : "applied-plans/historical.json");
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(fixtures, file), target);
      const state = makePluginStateStore(
        makeStateStore({ privateFileAccess: access }),
        AbsolutePath.make(root),
        access,
      );
      const store = record
        ? makeAppliedPlanStore({ providerId: "podman", layout: "record" })
        : makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });

      const read = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make("historical")));

      expect(read.status).toBe("readable");
      if (read.status !== "readable") throw new Error(`Historical state is ${read.status}`);
      expect(Object.keys(read.plan.services)).toEqual(["web", "worker"]);
      expect(read.plan.root).toBe(AbsolutePath.make("/srv/apps/historical"));
      expect(read.plan.routes.map(({ hostname, scheme }) => ({ hostname, scheme }))).toEqual([
        { hostname: "exact.lndo.site", scheme: "https" },
        { hostname: "*.x.lndo.site", scheme: "https" },
        { hostname: "*-x.lndo.site", scheme: "https" },
        { hostname: "wild.*.x.lndo.site", scheme: "http" },
      ]);
      for (const service of Object.values(read.plan.services)) {
        expect(service.hostAliases).toEqual([
          { hostname: "valid_alias", ip: "127.0.0.2" },
          { hostname: "host.lando.internal", ip: "host-gateway" },
        ]);
      }
      expect(read.plan.services[ServiceName.make("web")]?.certs).toEqual({
        cn: "web.historical.internal",
        sans: [
          "web",
          "web.historical.internal",
          "exact.lndo.site",
          "*.x.lndo.site",
          "*.lndo.site",
          "localhost",
          "127.0.0.1",
        ],
        caId: "test",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
