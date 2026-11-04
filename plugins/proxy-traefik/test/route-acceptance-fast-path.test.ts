import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { renderTraefikDashboardConfig } from "../src/dashboard.ts";
import {
  appCertificateFiles,
  dashboardConfigFile,
  defaultCertificateFiles,
  defaultDomainFile,
  defaultIssuerFile,
  defaultTlsFile,
  routeFile,
} from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { renderTraefikDefaultTlsConfig, renderTraefikDynamicConfig } from "../src/routing.ts";
import { certificatePem, privateKeyPem } from "./current-certificate-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

const first = httpsRoutes[0];
if (first === undefined) throw new Error("route fixture missing");

test.each(["linux", "darwin", "wsl"] as const)(
  "fresh %s HTTP application proves unchanged routes without writes, CA, or restart",
  async (platform) => {
    const fixture = makeAcceptanceFixture(platform);
    const route = { ...first, scheme: "http" as const };
    let restarts = 0;
    const dependencies = {
      ...fixture.dependencies,
      globalApp: {
        ...fixture.dependencies.globalApp,
        restartRunningService: () =>
          Effect.sync(() => {
            restarts++;
            return true;
          }),
      },
    };
    await Effect.runPromise(makeTraefikRouterService(dependencies).applyRoutes([route], app));
    fixture.operations.length = 0;
    fixture.calls.length = 0;
    fixture.runtime.requests.length = 0;

    await Effect.runPromise(makeTraefikRouterService(dependencies).applyRoutes([route], app));

    expect(fixture.operations).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(restarts).toBe(0);
    expect(fixture.runtime.requests).toHaveLength(1);
  },
);

test.each(["linux", "darwin", "wsl"] as const)(
  "fresh %s HTTPS application reuses current persisted certificates before issuing or writing",
  async (platform) => {
    const fixture = makeAcceptanceFixture(platform);
    const paths = fixture.dependencies.paths;
    const route = { ...first, hostname: "demo.lndo.site", scheme: "https" as const };
    fixture.files.set(defaultDomainFile(paths), "demo.lndo.site");
    fixture.files.set(dashboardConfigFile(paths), renderTraefikDashboardConfig("demo.lndo.site"));
    const certificates = appCertificateFiles(paths, app);
    const defaults = defaultCertificateFiles(paths, "demo.lndo.site");
    for (const pair of [certificates, defaults]) {
      fixture.files.set(pair.cert, certificatePem);
      fixture.files.set(pair.key, privateKeyPem);
    }
    fixture.files.set(defaultIssuerFile(paths, "demo.lndo.site"), certificatePem);
    fixture.files.set(
      defaultTlsFile(paths),
      renderTraefikDefaultTlsConfig({
        certFile: "/etc/traefik/dynamic/certs/default-demo.lndo.site.crt",
        keyFile: "/etc/traefik/dynamic/certs/default-demo.lndo.site.key",
      }),
    );
    fixture.files.set(
      routeFile(paths, app),
      renderTraefikDynamicConfig([route], app, {
        certFile: "/etc/traefik/dynamic/certs/demo%2Fapp.crt",
        keyFile: "/etc/traefik/dynamic/certs/demo%2Fapp.key",
      }),
    );
    let restarts = 0;
    const service = makeTraefikRouterService({
      ...fixture.dependencies,
      globalApp: {
        ...fixture.dependencies.globalApp,
        restartRunningService: () =>
          Effect.sync(() => {
            restarts++;
            return true;
          }),
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(1798761600000);
        yield* service.applyRoutes([route], app);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(fixture.operations).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(restarts).toBe(0);
    expect(fixture.runtime.requests).toHaveLength(1);
  },
);
