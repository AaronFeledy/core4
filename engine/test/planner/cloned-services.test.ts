import { describe, expect, test } from "bun:test";

import { AppFeatureCloneError } from "@lando/sdk/errors";
import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

import { imageLacksInstallShell, materializeClonedServices } from "../../src/planner/cloned-services.ts";
import type { PlannedServiceDraft } from "../../src/planner/service-types.ts";
import type { RecordedClonedService } from "../../src/services/app-feature-types.ts";

const PROVIDER = ProviderId.make("docker");

const parentDraft = (overrides: Partial<PlannedServiceDraft["draft"]> = {}): PlannedServiceDraft => ({
  name: "web",
  hostnames: [],
  authoredArtifact: { kind: "ref", ref: "alpine:3.22" },
  authored: { byStore: new Map() },
  authoredStorage: undefined,
  homeIntent: { serviceType: "compose", home: false as const },
  logSources: [],
  routes: undefined,
  extensions: {},
  draft: {
    name: ServiceName.make("web"),
    serviceName: "web",
    type: "compose",
    serviceType: "compose",
    provider: PROVIDER,
    primary: true,
    base: "l337",
    featureIds: [],
    normalizedConfig: { image: "alpine:3.22", user: "1001", environment: { TZ: "UTC", DB_HOST: "db" } },
    environment: { TZ: "UTC", DB_HOST: "db" },
    user: "1001",
    artifact: { kind: "ref", ref: "alpine:3.22" },
    mounts: [{ type: "bind", source: "/host/app", target: PortablePath.make("/app"), readOnly: false }],
    storage: [],
    buildSteps: [{ id: "parent.build", phase: "build", command: ["true"] }],
    endpoints: [],
    dependsOn: [],
    hostAliases: [],
    ...overrides,
  },
});

const request = (overrides: Partial<RecordedClonedService> = {}): RecordedClonedService => ({
  feature: "schedule.compile",
  from: "web",
  name: "web-schedule",
  command: ["/usr/local/bin/supercronic", "-overlapping", "/usr/local/etc/supercronic/crontab"],
  extraBuildSteps: [{ id: "schedule.supercronic", phase: "build", user: "root", command: ["true"] }],
  omitConfigKeys: ["schedule"],
  ...overrides,
});

describe("cloned services", () => {
  test("copies the parent image, mounts, environment, and user onto the sidecar", () => {
    const parent = parentDraft();
    const networks = { frontend: {} };
    const cloned = materializeClonedServices({
      plannedServiceDrafts: [parent],
      clones: [request()],
      parentNetworksByName: new Map([["web", networks]]),
    });
    expect(cloned.drafts).toHaveLength(1);
    const sidecar = cloned.drafts[0]?.draft;
    expect(sidecar?.name).toEqual(ServiceName.make("web-schedule"));
    expect(sidecar?.artifact).toEqual(parent.draft.artifact);
    expect(sidecar?.mounts).toEqual(parent.draft.mounts);
    expect(sidecar?.environment).toEqual(parent.draft.environment);
    expect(sidecar?.user).toBe("1001");
    expect(sidecar?.command).toEqual(request().command);
    expect(sidecar?.dependsOn).toEqual([
      { service: ServiceName.make("web"), condition: "service_started", required: true },
    ]);
    expect(sidecar?.normalizedConfig.schedule).toBeUndefined();
    expect(cloned.parentNetworks.get("web-schedule")).toEqual(networks);
  });

  test("fails when extra build steps target a distroless parent image", () => {
    expect(imageLacksInstallShell("gcr.io/distroless/static")).toBe(true);
    expect(() =>
      materializeClonedServices({
        plannedServiceDrafts: [
          parentDraft({
            normalizedConfig: { image: "gcr.io/distroless/static" },
            artifact: { kind: "ref", ref: "gcr.io/distroless/static" },
          }),
        ],
        clones: [request()],
        parentNetworksByName: new Map(),
      }),
    ).toThrow(AppFeatureCloneError);
  });

  test("fails when the clone name already exists", () => {
    expect(() =>
      materializeClonedServices({
        plannedServiceDrafts: [parentDraft(), { ...parentDraft(), name: "web-schedule" }],
        clones: [request()],
        parentNetworksByName: new Map(),
      }),
    ).toThrow(AppFeatureCloneError);
  });
});
