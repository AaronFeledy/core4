import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, PortablePath, ServiceName } from "@lando/sdk/schema";

import { LANDO_FEATURE_ID, landoServiceFeature, landoServiceType } from "../src/services/lando.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = async (config: unknown, appRoot = "/srv/apps/myapp") => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { worker: config },
  });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");
  return composeServicePlan({
    serviceType: landoServiceType,
    service,
    appRoot,
    metadata: { resolvedAt: "2026-10-13T08:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
    serviceName: "worker",
    featureOverrides: new Map([[LANDO_FEATURE_ID, landoServiceFeature]]),
  });
};

describe("lando authored mounts", () => {
  test("keeps read-only and writable bind mounts alongside the default app mount", async () => {
    const plan = await planService({
      type: "lando",
      image: "alpine:3",
      home: false,
      mounts: ["./readonly.ini:/readonly.ini:ro", "./writable.ini:/writable.ini"],
    });

    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "/srv/apps/myapp",
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: "/srv/apps/myapp/readonly.ini",
        target: PortablePath.make("/readonly.ini"),
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: "/srv/apps/myapp/writable.ini",
        target: PortablePath.make("/writable.ini"),
        readOnly: false,
        realization: "passthrough",
      },
    ]);
    expect(String(plan.appMount?.target)).toBe("/app");
    expect(plan.storage).toEqual([]);
  });

  test("resolves relative bind sources against a Windows app root", async () => {
    const plan = await planService(
      {
        type: "lando",
        image: "alpine:3",
        appMount: false,
        mounts: [{ type: "bind", source: "./config/site.ini", target: "/etc/site.ini", readOnly: true }],
      },
      "C:\\Users\\aaron\\project",
    );

    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "C:\\Users\\aaron\\project\\config\\site.ini",
        target: PortablePath.make("/etc/site.ini"),
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    expect(plan.appMount).toBeUndefined();
  });

  test("lets an authored /app mount replace the default app mount", async () => {
    const plan = await planService({
      type: "lando",
      image: "alpine:3",
      mounts: [{ type: "bind", source: "./custom", target: "/app", readOnly: true }],
    });

    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "/srv/apps/myapp/custom",
        target: PortablePath.make("/app"),
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    expect(plan.appMount).toBeUndefined();
  });

  test("retains an explicit app mount target override with authored file binds", async () => {
    const plan = await planService({
      type: "lando",
      image: "alpine:3",
      appMount: { target: "/site" },
      mounts: ["./readonly.ini:/readonly.ini:ro"],
    });

    expect(String(plan.appMount?.target)).toBe("/site");
    expect(plan.mounts.map((mount) => String(mount.target))).toEqual(["/site", "/readonly.ini"]);
    expect(plan.mounts[1]?.readOnly).toBe(true);
    expect(String(plan.workingDirectory)).toBe("/site");
  });
});
