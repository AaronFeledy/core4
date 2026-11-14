import type { CertificatePair } from "@lando/sdk/certificates";
import { CaError } from "@lando/sdk/errors";
import type { CertificateSpec } from "@lando/sdk/services";
import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { renderTraefikDashboardConfig } from "../src/dashboard.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import {
  appCertificateFiles,
  dashboardConfigFile,
  defaultCertificateFiles,
  defaultDomainFile,
  defaultIssuerFile,
  defaultTlsFile,
  routeFile,
} from "../src/proxy-paths.ts";
import { routeReloadDigest } from "../src/route-reload-state.ts";
import { renderTraefikDefaultTlsConfig, renderTraefikDynamicConfig } from "../src/routing.ts";
import { makeAckStore } from "./observe-routes-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";
import pem from "./router-certificate-fixtures.json";

// Public test-only keys. Fixed validity: 2025 through 2027 (expiring), or 2036.
// Generated with openssl ca; ordinary tests need no external tools or host CA.
export { pem };
export const DAY_MS = 86_400_000;
export const expiry = Date.parse("2027-01-01T00:00:00Z");
export const now = expiry - 60 * DAY_MS;
export const domain = "test.lndo.site";
const first = httpsRoutes[0];
if (first === undefined) throw new Error("Route fixture missing");
export const route = { ...first, hostname: "app.test.lndo.site", scheme: "https" as const };
export const caFailure = new CaError({
  caId: "fixture-ca",
  message: "Root unavailable",
  remediation: "Run lando setup.",
});

export const makeCertificateFixture = (platform: "linux" | "win32" | "darwin" | "wsl" = "linux") => {
  const fixture = makeAcceptanceFixture(platform);
  const paths = fixture.dependencies.paths;
  const appFiles = appCertificateFiles(paths, app);
  const defaultFiles = defaultCertificateFiles(paths, domain);
  const issuer = defaultIssuerFile(paths, domain);
  const watched = routeFile(paths, app);
  const calls: CertificateSpec[] = [];
  const events: string[] = [];
  const state = {
    root: pem.rootA,
    issued: pem.current,
    rootReads: 0,
    restarts: 0,
    rootFailure: false,
    failIssue: 0,
  };
  const dependencies = {
    ...fixture.dependencies,
    stateStore: makeAckStore(events),
    observeTlsPeer: () => Effect.sync(() => state.issued.certificate),
    certificateAuthority: {
      id: "fixture-ca",
      setup: () => Effect.die("CA setup is forbidden"),
      root: Effect.suspend(() => {
        state.rootReads++;
        return state.rootFailure
          ? Effect.fail(caFailure)
          : Effect.succeed({ certificate: state.root, trusted: true });
      }),
      issueCert: (spec: CertificateSpec) =>
        Effect.suspend(() => {
          calls.push(spec);
          return calls.length === state.failIssue
            ? Effect.fail(caFailure)
            : Effect.succeed({
                certificate: state.issued.certificate,
                privateKey: Redacted.make(state.issued.privateKey),
                root: { certificate: state.root, trusted: true },
              });
        }),
    },
    globalApp: {
      ...fixture.dependencies.globalApp,
      restartRunningService: () =>
        Effect.sync(() => {
          state.restarts++;
          return true;
        }),
    },
  };
  const seed = (application: CertificatePair, defaults: CertificatePair = application) => {
    for (const [files, pair] of [
      [appFiles, application],
      [defaultFiles, defaults],
    ] as const) {
      fixture.files.set(files.cert, pair.certificate);
      fixture.files.set(files.key, pair.privateKey);
    }
    fixture.files.set(defaultDomainFile(paths), domain);
    fixture.files.set(dashboardConfigFile(paths), renderTraefikDashboardConfig(domain));
    fixture.files.set(issuer, pem.rootA);
    fixture.files.set(
      defaultTlsFile(paths),
      renderTraefikDefaultTlsConfig({
        certFile: `/etc/traefik/dynamic/certs/default-${domain}.crt`,
        keyFile: `/etc/traefik/dynamic/certs/default-${domain}.key`,
      }),
    );
    fixture.files.set(
      watched,
      renderTraefikDynamicConfig([route], app, {
        certFile: `/etc/traefik/dynamic/certs/${app.ownerKey}.crt`,
        keyFile: `/etc/traefik/dynamic/certs/${app.ownerKey}.key`,
      }) +
        `# lando-certificate-generation: ${routeReloadDigest([application.certificate, defaults.certificate])}\n`,
    );
  };
  const run = <A, E>(body: Effect.Effect<A, E>, at = now) =>
    Effect.runPromise(TestClock.setTime(at).pipe(Effect.andThen(body), Effect.provide(TestClock.layer())));
  const makeService = () => makeTraefikRouterService(dependencies);
  return {
    ...fixture,
    dependencies,
    appFiles,
    defaultFiles,
    issuer,
    watched,
    calls,
    events,
    state,
    seed,
    run,
    makeService,
  };
};
