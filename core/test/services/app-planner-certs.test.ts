import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { planAppPlannerCerts } from "./app-planner-certs-harness.ts";

test("issues a leaf certificate with the documented SAN coverage for certs: true", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const ca = makeTestCertificateAuthority();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      ca,
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
          edge: { type: "compose", image: "nginx:alpine", certs: true },
        },
        proxy: { web: [{ hostname: "alias.lndo.site" }] },
      }),
    });

    const issued = ca.calls.filter((call) => call.op === "issueCert");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.op === "issueCert" ? issued[0].spec.cn : undefined).toBe("web.certs-app.internal");
    expect(issued[0]?.op === "issueCert" ? issued[0].spec.sans : undefined).toEqual([
      "web",
      "web.certs-app.internal",
      "web.internal.test",
      "certs-app.lndo.site",
      "alias.lndo.site",
      "localhost",
      "127.0.0.1",
    ]);

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
      caId: "test",
    });
    expect(web?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(web?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
    expect(web?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "/tmp/test-certs/web.certs-app.internal.crt",
          target: "/etc/lando/certs/leaf/web.crt",
          readOnly: true,
        }),
        expect.objectContaining({
          source: "/tmp/test-certs/web.certs-app.internal.key",
          target: "/etc/lando/certs/leaf/web.key",
          readOnly: true,
        }),
      ]),
    );

    // l337-base services never compose lando.certs, so `certs: true` there issues nothing.
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
    const ca = makeTestCertificateAuthority();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      ca,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "certs-default-route",
        runtime: 4,
        services: { web: { type: "node:22", certs: true } },
      }),
    });

    const issued = ca.calls.find((call) => call.op === "issueCert");
    expect(issued?.op === "issueCert" ? issued.spec.sans : []).toContain("web.certs-default-route.lndo.site");
    expect(appPlan.routes.map((route) => route.hostname)).toContain("web.certs-default-route.lndo.site");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issues a leaf certificate for default type: tomcat without authored certs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-planner-certs-tomcat-"));
  const appRoot = join(root, "app");
  const cacheRoot = join(root, "cache");

  try {
    await mkdir(appRoot, { recursive: true });
    const ca = makeTestCertificateAuthority();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      ca,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "tomcat-certs",
        runtime: 4,
        services: { appserver: { type: "tomcat" } },
      }),
    });

    const issued = ca.calls.filter((call) => call.op === "issueCert");
    expect(issued).toHaveLength(1);
    const appserver = appPlan.services[ServiceName.make("appserver")];
    expect(appserver?.certs?.caId).toBe("test");
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
    const ca = makeTestCertificateAuthority();
    const appPlan = await planAppPlannerCerts({
      appRoot,
      cacheRoot,
      ca,
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "tomcat-certs-off",
        runtime: 4,
        services: { appserver: { type: "tomcat", certs: false } },
      }),
    });

    expect(ca.calls.filter((call) => call.op === "issueCert")).toHaveLength(0);
    const appserver = appPlan.services[ServiceName.make("appserver")];
    expect(appserver?.certs).toBeUndefined();
    expect(appserver?.environment.LANDO_SERVICE_CERT).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
