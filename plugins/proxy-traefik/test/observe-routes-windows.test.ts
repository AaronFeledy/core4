import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  acquisitionStateFile,
  appCertificateFiles,
  dashboardConfigFile,
  defaultCertificateFiles,
  defaultDomainFile,
  defaultTlsFile,
  routeFile,
} from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acknowledge, routeReloadDigest } from "../src/route-reload-state.ts";
import { renderTraefikDynamicConfig } from "../src/routing.ts";
import { acquisition, app, makeAckStore, makeObserveFixture, route } from "./observe-routes-fixture.ts";

test.each(["current", "stale", "missing"] as const)(
  "requires %s Windows generation acknowledgement without mutations",
  async (generation) => {
    const fixture = makeObserveFixture();
    const paths = { ...fixture.paths, platform: "win32" as const };
    fixture.files.set(acquisitionStateFile(paths), JSON.stringify(acquisition));
    fixture.files.set(defaultDomainFile(paths), "example.test");
    fixture.files.set(routeFile(paths, app), renderTraefikDynamicConfig([route], app));
    const stateStore = makeAckStore(fixture.mutations);
    const cert = appCertificateFiles(paths, app);
    const defaults = defaultCertificateFiles(paths, "example.test");
    if (generation !== "missing") {
      const snapshot = [
        routeFile(paths, app),
        cert.cert,
        cert.key,
        defaults.cert,
        defaults.key,
        defaultTlsFile(paths),
        dashboardConfigFile(paths),
      ].map((path) => fixture.files.get(path));
      await Effect.runPromise(acknowledge(stateStore, app, routeReloadDigest(snapshot)));
    }
    if (generation === "stale") fixture.files.set(dashboardConfigFile(paths), "changed-dashboard");
    fixture.mutations.length = 0;
    const service = makeTraefikRouterService({ ...fixture.dependencies, paths, stateStore });
    const evidence = await Effect.runPromise(service.observeRoutes(app, [route]));
    expect(evidence.observation.status).toBe(generation === "current" ? "present" : "unknown");
    expect(evidence.configuredAuthorities).toHaveLength(2);
    expect(fixture.mutations).toEqual([]);
  },
);

test("does not acknowledge or restart a pending Windows generation during observation", async () => {
  const fixture = makeObserveFixture();
  const paths = { ...fixture.paths, platform: "win32" as const };
  fixture.files.set(acquisitionStateFile(paths), JSON.stringify(acquisition));
  fixture.files.set(defaultDomainFile(paths), "example.test");
  const stateStore = makeAckStore(fixture.mutations);
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    paths,
    stateStore,
    globalApp: {
      ...fixture.dependencies.globalApp,
      restartRunningService: () => Effect.fail("restart-failed"),
    },
  });
  const requested = { ...route, scheme: "http" as const };
  await Effect.runPromise(service.applyRoutes([requested], app).pipe(Effect.result));
  fixture.mutations.length = 0;
  const evidence = await Effect.runPromise(service.observeRoutes(app, [requested]));
  expect(evidence.observation).toEqual({ status: "unknown" });
  expect(fixture.mutations).toEqual([]);
});
