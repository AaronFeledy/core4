import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalConfig, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";

import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import {
  appPlannerCertsPaths,
  makeUntouchableResolver,
  planAppPlannerCerts,
} from "./app-planner-certs-harness.ts";

test("plans a generated leaf certificate with the documented SAN coverage without contacting the CA", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const untouchable = makeUntouchableResolver();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      resolver: untouchable.resolver,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-app",
        runtime: 4,
        services: {
          web: {
            type: "node:22",
            certs: true,
            hostnames: ["web.internal.test"],
            routes: [{ hostname: "certs-app.lndo.site" }],
          },
          edge: { type: "compose", image: "nginx:alpine", certs: true, home: false },
        },
        proxy: { web: [{ hostname: "alias.lndo.site" }] },
      }),
    });

    expect(untouchable.calls()).toBe(0);
    const leaf = serviceCertificatePaths(
      appPlannerCertsPaths({ appRoot, cacheRoot }).certsDir,
      routeOwnerFromPlan(appPlan).ownerKey,
      "web",
    );

    const web = appPlan.services[ServiceName.make("web")];
    expect(web?.certs).toEqual({
      cn: "web.certs-app.internal",
      sans: [
        "web",
        "web.certs-app.internal",
        "web.internal.test",
        "certs-app.lndo.site",
        "alias.lndo.site",
        "localhost",
        "127.0.0.1",
      ],
      caId: "mkcert",
    });
    expect(web?.extensions).not.toHaveProperty("@lando/core/certs");
    expect(web?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(web?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
    expect(web?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: leaf.certPath,
          target: "/etc/lando/certs/leaf/web.crt",
          readOnly: true,
          createHostPath: false,
        }),
        expect.objectContaining({
          source: leaf.keyPath,
          target: "/etc/lando/certs/leaf/web.key",
          readOnly: true,
          createHostPath: false,
        }),
      ]),
    );

    // l337-base services never compose lando.certs, so `certs: true` there plans nothing.
    const edge = appPlan.services[ServiceName.make("edge")];
    expect(edge?.certs).toBeUndefined();
    expect(edge?.environment.LANDO_SERVICE_CERT).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("covers the generated default proxy hostname", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-default-route-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-default-route",
        runtime: 4,
        services: { web: { type: "node:22", certs: true } },
      }),
    });

    expect(appPlan.services[ServiceName.make("web")]?.certs?.sans).toContain(
      "web.certs-default-route.lndo.site",
    );
    expect(appPlan.routes.map((route) => route.hostname)).toContain("web.certs-default-route.lndo.site");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["certs-configured-domain", "global"])(
  "uses proxy.defaultDomain for the default route and certificate SANs of %s",
  async (name) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-domain-"));
    const appRoot = join(root, "app");
    try {
      await mkdir(appRoot, { recursive: true });
      // When
      const appPlan = await planAppPlannerCerts({
        appRoot,
        cacheRoot: join(root, "cache"),
        config: Schema.decodeUnknownSync(GlobalConfig)({ proxy: { defaultDomain: "lndo.test" } }),
        landofile: Schema.decodeUnknownSync(LandofileShape)({
          name,
          runtime: 4,
          services: { web: { type: "node:22", certs: true } },
        }),
      });
      // Then
      const hostname = `web.${name}.lndo.test`;
      expect(appPlan.routes.map((route) => route.hostname)).toEqual([hostname]);
      expect(appPlan.services[ServiceName.make("web")]?.certs?.sans).toContain(hostname);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("plans a generated leaf certificate for default type: tomcat without authored certs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-tomcat-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "tomcat-certs",
        runtime: 4,
        services: { appserver: { type: "tomcat" } },
      }),
    });

    const appserver = appPlan.services[ServiceName.make("appserver")];
    expect(appserver?.certs?.caId).toBe("mkcert");
    expect(appserver?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/appserver.crt");
    expect(appserver?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/appserver.key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("honors authored certs: false on type: tomcat", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-tomcat-off-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "tomcat-certs-off",
        runtime: 4,
        services: { appserver: { type: "tomcat", certs: false } },
      }),
    });

    const appserver = appPlan.services[ServiceName.make("appserver")];
    expect(appserver?.certs).toBeUndefined();
    expect(appserver?.extensions["@lando/core/certs"]).toBe("none");
    expect(appserver?.environment.LANDO_SERVICE_CERT).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
