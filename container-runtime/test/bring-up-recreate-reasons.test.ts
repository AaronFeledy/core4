import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUpRecreateReasons, presentLogicalCreateConfig } from "../src/podman/bring-up-recreate.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-recreate-reasons.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 8080,
      protocol: "http",
      name: "http",
      publication: { bindAddress: "127.0.0.1", hostPort: 18080 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: AppId.make("recreate-reasons"),
  name: "Recreate Reasons",
  slug: "recreate-reasons",
  root: AbsolutePath.make("/tmp/lando-recreate-reasons"),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("presentLogicalCreateConfig", () => {
  const physical: AppPlan = {
    ...plan,
    networking: { perAppBridge: { name: "machine-physical-network", driver: "bridge" } },
  };

  test("translates an exact physical match while preserving all other labels", () => {
    // Given physical create evidence with an unrelated label.
    const labels: Readonly<Record<string, string>> = {
      ...commonContainerLabels(physical, service),
      unrelated: "preserved",
    };
    const logical = commonContainerLabels(plan, service)[CREATE_CONFIG_LABEL];
    if (logical === undefined) throw new TypeError("logical fingerprint is missing");
    expect(labels[CREATE_CONFIG_LABEL]).not.toBe(logical);
    // When inspect presents the evidence in the logical representation.
    const presented = presentLogicalCreateConfig(labels, { physical, logical: plan, service: serviceName });
    // Then only the fingerprint changes, without mutating the daemon labels.
    expect(presented).toEqual({ ...labels, [CREATE_CONFIG_LABEL]: logical });
    expect(labels[CREATE_CONFIG_LABEL]).toBe(commonContainerLabels(physical, service)[CREATE_CONFIG_LABEL]);
  });

  const staleLabels: Array<Readonly<Record<string, string>>> = [
    {},
    { [CREATE_CONFIG_LABEL]: "v1:old-config" },
  ];
  test.each(staleLabels)("reports config drift for missing or mismatched physical evidence: %j", (labels) => {
    // Given absent or stale physical create evidence.
    // When inspect tries to present a logical fingerprint.
    const presented = presentLogicalCreateConfig(labels, { physical, logical: plan, service: serviceName });
    // Then unverified physical evidence cannot be presented as a config match.
    expect(presented[CREATE_CONFIG_LABEL]).toBeUndefined();
    expect(bringUpRecreateReasons(plan, service, { labels: presented }, { skipAbsentFields: true })).toEqual([
      "config",
    ]);
  });

  test("reports config drift when observed logical evidence does not match physical creation", () => {
    // Given logical labels that cannot prove the physical network configuration.
    const labels: Readonly<Record<string, string>> = {
      ...commonContainerLabels(plan, service),
      unrelated: "preserved",
    };
    expect(labels[CREATE_CONFIG_LABEL]).not.toBe(
      commonContainerLabels(physical, service)[CREATE_CONFIG_LABEL],
    );
    // When inspect presents physical evidence for logical preflight.
    const presented = presentLogicalCreateConfig(labels, { physical, logical: plan, service: serviceName });
    // Then the unverified fingerprint cannot hide config drift.
    expect(presented[CREATE_CONFIG_LABEL]).toBeUndefined();
    expect(presented.unrelated).toBe("preserved");
    expect(bringUpRecreateReasons(plan, service, { labels: presented }, { skipAbsentFields: true })).toEqual([
      "config",
    ]);
  });
});

describe("bringUpRecreateReasons", () => {
  test("reports known missing config labels even when absent custom metadata is skipped", () => {
    // Given known-empty labels from a real container inspect.
    const snapshot = { labels: {} };
    // When preflight compares the desired config.
    const reasons = bringUpRecreateReasons(plan, service, snapshot, { skipAbsentFields: true });
    // Then missing labels request the migration recreation.
    expect(reasons).toEqual(["config"]);
  });

  test("preserves existing reason priority before config drift", () => {
    // Given drift in all four recreate conditions.
    const snapshot = {
      labels: {},
      publishFingerprint: "different",
      bindSources: { "/run/lando/ssh-agent": "bind:/old" },
      networkNames: ["unrelated"],
    };
    // When the shared recreation policy runs.
    const reasons = bringUpRecreateReasons(plan, service, snapshot);
    // Then config follows the existing port, mount, and network reasons.
    expect(reasons).toEqual(["publish-port", "bind-source", "network", "config"]);
  });

  test("keeps a container with matching desired config labels", () => {
    // Given the labels actually emitted for the desired service.
    const snapshot = { labels: commonContainerLabels(plan, service) };
    // When only config metadata is available at custom-provider preflight.
    const reasons = bringUpRecreateReasons(plan, service, snapshot, { skipAbsentFields: true });
    // Then no recreation is needed.
    expect(reasons).toEqual([]);
  });
  test("skipAbsentFields ignores drift when inspect snapshot fields are omitted", () => {
    expect(bringUpRecreateReasons(plan, service, {}, { skipAbsentFields: true })).toEqual([]);
  });

  test("reports publish-port, bind-source, and network drift when snapshot fields are present", () => {
    expect(
      bringUpRecreateReasons(
        plan,
        service,
        {
          publishFingerprint: "8080/tcp@127.0.0.1:18081",
          bindSources: { "/run/lando/ssh-agent": "bind:/tmp/old" },
          networkNames: ["unrelated"],
        },
        { skipAbsentFields: true },
      ),
    ).toEqual(["publish-port", "bind-source", "network"]);
  });

  test("does not recreate when only an app-mount bind source spelling changes", () => {
    const withAppMount: ServicePlan = {
      ...service,
      mounts: [
        {
          type: "bind",
          source: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app",
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "passthrough",
        },
      ],
    };
    expect(
      bringUpRecreateReasons(
        plan,
        withAppMount,
        {
          bindSources: {
            "/app": "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app",
          },
        },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
  });
});

describe("agent socket storage reconciliation", () => {
  test.each(["ssh", "gpg"] as const)("compares %s sidecar storage using the volume name", (kind) => {
    const target = PortablePath.make(`/run/lando/${kind}-agent`);
    const sidecar: ServicePlan = {
      ...service,
      endpoints: [],
      storage: [{ store: "agent-volume", target, readOnly: false }],
    };
    expect(bringUpRecreateReasons(plan, sidecar, { bindSources: {} }, { skipAbsentFields: true })).toEqual([
      "bind-source",
    ]);
    expect(
      bringUpRecreateReasons(
        plan,
        sidecar,
        { bindSources: { [target]: "volume:agent-volume" } },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
    expect(
      bringUpRecreateReasons(
        plan,
        sidecar,
        { bindSources: { [target]: "volume:previous-volume" } },
        { skipAbsentFields: true },
      ),
    ).toEqual(["bind-source"]);
  });

  test("does not turn unrelated data storage into an agent socket recreation condition", () => {
    const dataService: ServicePlan = {
      ...service,
      endpoints: [],
      storage: [{ store: "database-data", target: PortablePath.make("/var/lib/database"), readOnly: false }],
    };
    expect(
      bringUpRecreateReasons(plan, dataService, { bindSources: {} }, { skipAbsentFields: true }),
    ).toEqual([]);
  });
});

test("an ordinary app bind at the sidecar host endpoint does not grant sidecar drift ownership", () => {
  const ordinary: ServicePlan = {
    ...service,
    endpoints: [],
    mounts: [
      {
        type: "bind",
        source: "/app/auth",
        target: PortablePath.make("/ssh-auth"),
        readOnly: true,
        realization: "passthrough",
      },
    ],
  };
  expect(
    bringUpRecreateReasons(
      plan,
      ordinary,
      { bindSources: { "/ssh-auth": "/previous/auth" } },
      { skipAbsentFields: true },
    ),
  ).toEqual([]);
});
