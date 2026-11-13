import { describe, expect, test } from "bun:test";

import { AppFeatureCloneError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  CLONED_SERVICE_PROVENANCE_KEY,
  DatabaseConnection,
  LogSourceId,
  PortNumber,
  PortablePath,
  ProviderId,
  ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import { Schema } from "effect";

import { materializeClonedServices } from "../../src/planner/cloned-services.ts";
import type { PlannedServiceDraft } from "../../src/planner/service-types.ts";
import type { RecordedClonedService } from "../../src/services/app-feature-types.ts";

const PROVIDER = ProviderId.make("docker");

const parentDraft = (overrides: Partial<PlannedServiceDraft["draft"]> = {}): PlannedServiceDraft => ({
  name: "web",
  hostnames: [],
  authoredArtifact: { kind: "ref", ref: "alpine:3.22" },
  pullPolicy: undefined,
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

const clone = (
  options: {
    readonly parent?: PlannedServiceDraft;
    readonly request?: RecordedClonedService;
    readonly reservedDnsNames?: Parameters<typeof materializeClonedServices>[0]["reservedDnsNames"];
  } = {},
) =>
  materializeClonedServices({
    plannedServiceDrafts: [options.parent ?? parentDraft()],
    clones: [options.request ?? request()],
    parentNetworksByName: new Map(),
    ...(options.reservedDnsNames === undefined ? {} : { reservedDnsNames: options.reservedDnsNames }),
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
    expect(cloned.drafts[0]?.pullPolicy).toEqual(parent.pullPolicy);
    expect(sidecar?.entrypoint).toEqual(request().command);
    expect(sidecar).not.toHaveProperty("command");
    expect(sidecar?.healthcheck).toEqual({
      kind: "none",
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
    });
    expect(sidecar).not.toHaveProperty("readiness");
    expect(sidecar?.dependsOn).toEqual([
      { service: ServiceName.make("web"), condition: "service_started", required: true },
    ]);
    expect(sidecar?.normalizedConfig.schedule).toBeUndefined();
    expect(sidecar?.provenance).toEqual({
      [CLONED_SERVICE_PROVENANCE_KEY]: { feature: "schedule.compile", from: "web" },
    });
    expect(cloned.drafts[0]?.storeOwner).toBe("web");
    expect(cloned.parentNetworks.get("web-schedule")).toEqual(networks);
  });

  test("replaces a parent entrypoint with the requested argv as its only process", () => {
    const parent = parentDraft({ entrypoint: ["node", "server.js"], command: ["node", "server.js"] });
    const sidecar = clone({ parent }).drafts[0]?.draft;
    expect(sidecar?.entrypoint).toEqual(request().command);
    expect(sidecar).not.toHaveProperty("command");
  });

  test("runs a string request command through the shell as its only process", () => {
    const sidecar = clone({ request: request({ command: "echo hello" }) }).drafts[0]?.draft;
    expect(sidecar?.entrypoint).toEqual(["sh", "-c", "echo hello"]);
    expect(sidecar).not.toHaveProperty("command");
  });

  test("disables the healthcheck whether or not the parent has one", () => {
    const disabled = { kind: "none" as const, intervalSeconds: 10, timeoutSeconds: 5, retries: 5 };
    const parentCheck = {
      kind: "command" as const,
      command: ["true"],
      intervalSeconds: 30,
      timeoutSeconds: 4,
      retries: 2,
    };
    expect(clone({ parent: parentDraft({ healthcheck: parentCheck }) }).drafts[0]?.draft.healthcheck).toEqual(
      disabled,
    );
    expect(clone().drafts[0]?.draft.healthcheck).toEqual(disabled);
  });

  test("overrides the cloned user when the request sets one", () => {
    const cloned = clone({ request: request({ user: "root" }) });
    expect(cloned.drafts[0]?.draft.user).toBe("root");
    expect(cloned.drafts[0]?.draft.normalizedConfig.user).toBe("root");
  });

  test("keeps image-phase build steps and drops the parent's app phase", () => {
    const parent = parentDraft({
      buildSteps: [
        { id: "parent.build", phase: "build", command: ["true"] },
        { id: "parent.app", phase: "app", command: ["composer", "install"] },
      ],
    });
    const cloned = clone({ parent });
    expect(cloned.drafts[0]?.draft.buildSteps.map((step) => step.id)).toEqual([
      "parent.build",
      "schedule.supercronic",
    ]);
  });

  test("carries none of the parent's log sources", () => {
    const parent = {
      ...parentDraft(),
      logSources: [
        {
          id: LogSourceId.make("access"),
          path: AbsolutePath.make("/var/log/access.log"),
          stream: "stdout" as const,
          strategy: "redirect" as const,
          required: false,
          timestamps: false,
        },
      ],
    };
    expect(clone({ parent }).drafts[0]?.logSources).toEqual([]);
  });

  test("pins inherited unpinned build steps only when the clone overrides user", () => {
    const pinned = clone({ request: request({ user: "www-data" }) }).drafts[0]?.draft.buildSteps;
    expect(pinned?.map((step) => step.user ?? null)).toEqual(["1001", "root"]);

    const untouched = clone().drafts[0]?.draft.buildSteps;
    expect(untouched?.[0]).not.toHaveProperty("user");
    expect(untouched?.[1]?.user).toBe("root");
  });

  test("keeps an explicit inherited build-step user on a user-override clone", () => {
    const parent = parentDraft({
      buildSteps: [{ id: "parent.build", phase: "build", user: "builder", command: ["true"] }],
    });
    const steps = clone({ parent, request: request({ user: "www-data" }) }).drafts[0]?.draft.buildSteps;
    expect(steps?.[0]?.user).toBe("builder");
  });

  test("strips listener, publication, probe, certificate, and alias inputs from the clone config", () => {
    const normalizedConfig = Schema.decodeUnknownSync(ServiceConfig)({
      image: "alpine:3.22",
      environment: { TZ: "UTC" },
      ports: ["8099:80"],
      expose: [9000],
      endpoints: [{ _tag: "internal", protocol: "http", port: 8080 }],
      routes: ["app.lndo.site"],
      hostnames: ["web.example.internal"],
      healthcheck: { command: "true" },
      readiness: { command: "true" },
      certs: true,
      networks: { default: { aliases: ["web.internal"] }, backend: {} },
      "x-feature": { keep: true },
    });
    const cloned = clone({
      parent: parentDraft({ normalizedConfig }),
      request: request({ omitConfigKeys: ["x-feature"] }),
    });
    const config = cloned.drafts[0]?.draft.normalizedConfig;
    for (const key of [
      "ports",
      "expose",
      "endpoints",
      "routes",
      "hostnames",
      "healthcheck",
      "readiness",
      "certs",
      "networks",
      "x-feature",
    ])
      expect(config).not.toHaveProperty(key);
    expect(config?.environment).toEqual({ TZ: "UTC" });
  });

  test("copies network membership without the parent's aliases", () => {
    const cloned = materializeClonedServices({
      plannedServiceDrafts: [parentDraft()],
      clones: [request()],
      parentNetworksByName: new Map([
        [
          "web",
          {
            default: { aliases: ["web.internal", "database"] },
            backend: {},
          },
        ],
      ]),
    });
    expect(cloned.parentNetworks.get("web-schedule")).toEqual({ default: {}, backend: {} });
  });

  test("drops database identity and storage ownership from the clone", () => {
    const cloned = clone({
      parent: parentDraft({
        connection: DatabaseConnection.make({
          family: "mysql",
          port: PortNumber.make(3306),
          creds: { user: "app", password: "secret", database: "app" },
        }),
        storageOwnership: [{ target: "/data", seededOwners: [] }],
      }),
    });
    const draft = cloned.drafts[0]?.draft;
    expect(draft).not.toHaveProperty("connection");
    expect(draft).not.toHaveProperty("nonSqlCreds");
    expect(draft).not.toHaveProperty("sqlite");
    expect(draft).not.toHaveProperty("storageOwnership");
  });

  test.each([
    ["hostname", ["services", "api", "hostnames", 0], "hostname"],
    ["network alias", ["services", "api", "networks", "default", "aliases", 1], "network alias"],
    ["service name", ["services", "Taken"], "service name"],
    ["service named hostnames", ["services", "hostnames"], "service name"],
    ["service named networks", ["services", "networks"], "service name"],
  ] as const)(
    "rejects a clone name that collides case-insensitively with an existing %s",
    (_label, path, kind) => {
      const reservedDnsNames = [
        {
          network: "default",
          name: "taken",
          service: "taken",
          path: [...path],
          concrete: true,
          authored: true,
        },
      ];
      try {
        clone({ request: request({ name: "TAKEN" }), reservedDnsNames });
        throw new Error("expected a clone-name collision");
      } catch (error) {
        expect(error).toBeInstanceOf(AppFeatureCloneError);
        if (!(error instanceof AppFeatureCloneError)) return;
        expect(error.reason).toBe("name-collision");
        expect(error.message).toContain("taken");
        expect(error.message).toContain(kind);
        expect(error.remediation).toContain("taken");
      }
    },
  );

  test.each([
    ["scratch", "scratch"],
    ["scratch tag", "scratch:latest"],
    ["distroless", "gcr.io/distroless/static"],
    ["registry scratch", "ghcr.io/example/scratch:latest"],
  ])("fails when extra build steps target a %s parent image", (_label, image) => {
    try {
      materializeClonedServices({
        plannedServiceDrafts: [
          parentDraft({
            normalizedConfig: { image },
            artifact: { kind: "ref", ref: image },
          }),
        ],
        clones: [request()],
        parentNetworksByName: new Map(),
      });
      throw new Error("expected an unsupported-image failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFeatureCloneError);
      if (!(error instanceof AppFeatureCloneError)) return;
      expect(error.reason).toBe("unsupported-image");
      expect(error.image).toBe(image);
    }
  });

  test("rejects two clones whose names differ only by case", () => {
    try {
      materializeClonedServices({
        plannedServiceDrafts: [parentDraft()],
        clones: [request({ name: "Timer" }), request({ name: "timer" })],
        parentNetworksByName: new Map(),
      });
      throw new Error("expected a duplicate clone");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFeatureCloneError);
      if (!(error instanceof AppFeatureCloneError)) return;
      expect(error.reason).toBe("duplicate-clone");
      expect(error.service).toBe("timer");
    }
  });

  test("rejects a clone whose derived internal name is already claimed", () => {
    const derived = "web-schedule.clones.internal";
    try {
      materializeClonedServices({
        plannedServiceDrafts: [parentDraft()],
        clones: [request()],
        parentNetworksByName: new Map(),
        appSlug: "clones",
        reservedDnsNames: [
          {
            network: "default",
            name: derived,
            service: "api",
            path: ["services", "api", "hostnames", 0],
            concrete: false,
            authored: true,
          },
        ],
      });
      throw new Error("expected a derived-name collision");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFeatureCloneError);
      if (!(error instanceof AppFeatureCloneError)) return;
      expect(error.reason).toBe("name-collision");
      expect(error.message).toContain(derived);
      expect(error.remediation).toContain(derived);
    }
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
