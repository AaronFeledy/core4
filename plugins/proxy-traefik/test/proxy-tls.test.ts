import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { CaError, ProxyApplyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";

import { app, httpsRoutes, makeHarness } from "./proxy-tls-harness.ts";

describe("Traefik ProxyService TLS", () => {
  test("issues exact default and sorted per-app SANs for HTTPS routes", async () => {
    // Given: a configured proxy with no certificate material.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    // When: HTTPS and both-scheme routes are applied.
    await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

    // Then: route application issues deterministic specs without running CA setup.
    expect(harness.calls).toEqual([
      {
        cn: "*.lndo.site",
        sans: ["*.lndo.site", "lndo.site", "traefik.lndo.site"],
      },
      {
        cn: "a.demo.lndo.site",
        sans: ["a.demo.lndo.site", "z.demo.lndo.site"],
      },
    ]);
    expect(harness.operations).not.toContain("ca:setup");
  });

  test("writes copied PEMs before valid file-provider TLS configuration", async () => {
    // Given: an HTTPS route and issued PEM source files.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    // When: routes are applied.
    await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

    // Then: the durable default store and per-app certificate use separate official TLS files.
    const routePath = "/lando/global/proxy-traefik/dynamic/routes-demo%2Fapp.yml";
    const defaultPath = "/lando/global/proxy-traefik/dynamic/tls-default.yml";
    expect(Bun.YAML.parse(harness.files.get(routePath) ?? "")).toEqual(
      expect.objectContaining({
        tls: {
          certificates: [
            {
              certFile: "/etc/traefik/dynamic/certs/demo%2Fapp.crt",
              keyFile: "/etc/traefik/dynamic/certs/demo%2Fapp.key",
            },
          ],
        },
      }),
    );
    expect(Bun.YAML.parse(harness.files.get(defaultPath) ?? "")).toEqual({
      tls: {
        stores: {
          default: {
            defaultCertificate: {
              certFile: "/etc/traefik/dynamic/certs/default-lndo.site.crt",
              keyFile: "/etc/traefik/dynamic/certs/default-lndo.site.key",
            },
          },
        },
      },
    });
    expect(harness.files.get("/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.crt")).toBe("app cert");
    expect(harness.operations.indexOf(`write:${routePath}`)).toBeGreaterThan(
      harness.operations.indexOf("write-secret:/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.key"),
    );
    expect(
      harness.operations.filter((operation) => operation.includes("/certs/") && operation.endsWith(".key")),
    ).toEqual([
      "write-secret:/lando/global/proxy-traefik/dynamic/certs/default-lndo.site.key",
      "write-secret:/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.key",
    ]);
    expect(harness.operations.indexOf(`write:${routePath}`)).toBeGreaterThan(
      harness.operations.indexOf(`write:${defaultPath}`),
    );
  });

  test("does not set up or issue through the CA for HTTP-only routes", async () => {
    // Given: a proxy configured with an active CA.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    // When: only HTTP routes are applied.
    await Effect.runPromise(
      harness.service.applyRoutes(
        [
          {
            hostname: "demo.lndo.site",
            scheme: "http",
            service: ServiceName.make("web"),
            backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
          },
        ],
        app,
      ),
    );

    // Then: no CA operation occurs.
    expect(harness.calls).toEqual([]);
    expect(harness.operations).not.toContain("ca:setup");
  });

  test("reissues the app certificate when HTTPS hostname coverage changes", async () => {
    // Given: an app with existing HTTPS hostname coverage.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

    // When: the same app changes its HTTPS hostname.
    const existingRoute = httpsRoutes[0];
    if (existingRoute === undefined) throw new Error("expected HTTPS route fixture");
    await Effect.runPromise(
      harness.service.applyRoutes(
        [
          {
            ...existingRoute,
            hostname: "new.demo.lndo.site",
          },
        ],
        app,
      ),
    );

    // Then: a fresh deterministic app certificate covers only the new hostname.
    expect(harness.calls.at(-1)).toEqual({
      cn: "new.demo.lndo.site",
      sans: ["new.demo.lndo.site"],
    });
  });

  test("removes app certificates before replacing HTTPS routes with HTTP-only routes", async () => {
    // Given: an app with materialized HTTPS certificate files.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));
    harness.operations.splice(0);

    // When: the app transitions to an HTTP-only route.
    await Effect.runPromise(
      harness.service.applyRoutes(
        [
          {
            hostname: "demo.lndo.site",
            scheme: "http",
            service: ServiceName.make("web"),
            backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
          },
        ],
        app,
      ),
    );

    // Then: both deterministic app PEMs are removed before the HTTP route trigger.
    const routeWrite = harness.operations.indexOf(
      "write:/lando/global/proxy-traefik/dynamic/routes-demo%2Fapp.yml",
    );
    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.crt")).toBe(false);
    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.key")).toBe(false);
    expect(routeWrite).toBeGreaterThan(
      harness.operations.indexOf("remove:/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.key"),
    );
  });

  test("removes app TLS material and stop removes all TLS material", async () => {
    // Given: two apps with TLS files.
    const harness = makeHarness();
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(harness.service.applyRoutes(httpsRoutes, app));

    // When: app routes are removed, then the proxy is stopped.
    await Effect.runPromise(harness.service.removeRoutes(app));
    expect(harness.files.has("/lando/global/proxy-traefik/dynamic/certs/demo%2Fapp.crt")).toBe(false);
    await Effect.runPromise(harness.service.stop);

    // Then: neither default configuration nor certificate material remains.
    expect(
      [...harness.files.keys()].filter((path) => path.startsWith("/lando/global/proxy-traefik/dynamic")),
    ).toEqual([]);
  });

  test("preserves a tagged CA failure inside ProxyApplyError", async () => {
    // Given: the active CA fails issuance with a tagged error.
    const caFailure = new CaError({ message: "issuance failed", caId: "test-ca" });
    const harness = makeHarness(caFailure);
    await Effect.runPromise(Effect.scoped(harness.service.setup({ defaultDomain: "lndo.site" })));

    // When: an HTTPS route is applied.
    const exit = await Effect.runPromiseExit(harness.service.applyRoutes(httpsRoutes, app));

    // Then: the proxy wrapper retains the exact tagged CA failure and setup remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof ProxyApplyError).toBe(true);
      if (Option.isSome(failure) && failure.value instanceof ProxyApplyError) {
        expect(failure.value.cause).toBe(caFailure);
        expect(failure.value.remediation).toContain("lando setup");
        expect(failure.value.remediation).toContain("active CertificateAuthority");
      }
    }
  });
});
