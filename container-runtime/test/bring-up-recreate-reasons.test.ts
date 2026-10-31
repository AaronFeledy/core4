import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { DateTime } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";

import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { HOST_PROXY_SESSION_LABEL, HOST_PROXY_TRANSPORT_EXTENSION_KEY } from "../src/labels.ts";
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
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("host-proxy session reconciliation", () => {
  const sessionDigest = (session: string): string => sha256Hex(session).slice(0, 16);
  const trustedExtension = (session: string): ServicePlan["extensions"] => ({
    [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionDigest: sessionDigest(session) },
  });
  const hostProxyMounts = (sources: {
    readonly socket: string;
    readonly credentials: string;
  }): ServicePlan["mounts"] => [
    {
      type: "bind",
      source: sources.socket,
      target: PortablePath.make("/run/lando/host-proxy.sock"),
      readOnly: true,
      realization: "passthrough",
    },
    {
      type: "bind",
      source: sources.credentials,
      target: PortablePath.make("/run/lando/host-proxy/credentials"),
      readOnly: true,
      realization: "passthrough",
    },
  ];
  const overlay: ServicePlan = {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      LANDO_HOST_PROXY_DEPTH: "0",
    },
    mounts: hostProxyMounts({
      socket: "/home/user/session/host-proxy.sock",
      credentials: "/home/user/session/credentials",
    }),
    extensions: trustedExtension("current-session"),
  };
  /** Pre-S3 env overlay still observed on containers created by older builds. */
  const legacyEnvOverlay: ServicePlan = {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SESSION: "current-session",
      LANDO_HOST_PROXY_TOKEN: "token-1",
      LANDO_HOST_PROXY_APP: "app-1",
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
    },
    mounts: [
      {
        type: "bind",
        source: "/home/user/session/host-proxy.sock",
        target: PortablePath.make("/run/lando/host-proxy.sock"),
        readOnly: true,
        realization: "passthrough",
      },
    ],
  };

  test("emits only a trusted extension digest and excludes it from create-config", () => {
    // Given two sessions of the same service configuration under the transport extension.
    const previous: ServicePlan = {
      ...overlay,
      extensions: trustedExtension("previous-session"),
    };
    // When labels are projected.
    const labels = commonContainerLabels(plan, overlay);
    // Then the digest comes from the extension, never from env, and create-config stays stable across sessions.
    expect(labels[HOST_PROXY_SESSION_LABEL]).toBe(sessionDigest("current-session"));
    expect(labels[CREATE_CONFIG_LABEL]).toBe(commonContainerLabels(plan, previous)[CREATE_CONFIG_LABEL]);
    expect(commonContainerLabels(plan, service)[HOST_PROXY_SESSION_LABEL]).toBeUndefined();
    expect(commonContainerLabels(plan, legacyEnvOverlay)[HOST_PROXY_SESSION_LABEL]).toBeUndefined();
  });

  test("spoofed authored host-proxy-session labels cannot win without a trusted extension", () => {
    // Given a forged Compose label matching a real digest but no transport extension.
    const spoofed: ServicePlan = {
      ...service,
      extensions: {
        compose: { labels: { [HOST_PROXY_SESSION_LABEL]: sessionDigest("current-session") } },
      },
    };
    // When
    const labels = commonContainerLabels(plan, spoofed);
    // Then the marker is stripped and a mismatched observed session cannot arm bind-source without the extension.
    expect(labels[HOST_PROXY_SESSION_LABEL]).toBeUndefined();
    expect(
      bringUpRecreateReasons(
        plan,
        spoofed,
        {
          labels: {
            ...labels,
            [HOST_PROXY_SESSION_LABEL]: sessionDigest("other"),
          },
        },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
  });

  test.each(["previous-session", undefined] as const)(
    "recreates when inspected session is %s under a trusted extension",
    (session) => {
      // Given known labels with a stale or absent session marker.
      const labels = {
        ...commonContainerLabels(plan, overlay),
        [HOST_PROXY_SESSION_LABEL]: session === undefined ? "" : sessionDigest(session),
      };
      // When bring-up checks the current overlay.
      const reasons = bringUpRecreateReasons(plan, overlay, { labels }, { skipAbsentFields: true });
      // Then the socket's backing session requires recreation, not config drift.
      expect(reasons).toEqual(["bind-source"]);
    },
  );

  test.each(["socket", "credentials", "neither"] as const)(
    "checks bind-source recreation when %s drifts under a trusted extension",
    (drift) => {
      // Given matching session labels and independently varying socket and credentials sources.
      const labels = commonContainerLabels(plan, overlay);
      const bindSources = {
        "/run/lando/host-proxy.sock":
          drift === "socket" ? "/home/user/old/host-proxy.sock" : "/home/user/session/host-proxy.sock",
        "/run/lando/host-proxy/credentials":
          drift === "credentials" ? "/home/user/old/credentials" : "/home/user/session/credentials",
      };
      // When bring-up compares the observed binds with the trusted overlay.
      const reasons = bringUpRecreateReasons(
        plan,
        overlay,
        { labels, bindSources },
        { skipAbsentFields: true },
      );
      // Then either source drift requires recreation, while matching sources do not.
      expect(reasons).toEqual(drift === "neither" ? [] : ["bind-source"]);
    },
  );

  test("treats a legacy env-only running container as stale against the credentials-file overlay", () => {
    // Given an older container that only had SESSION env + socket bind (no credentials, no extension).
    const legacyLabels = {
      // Old builds stamped the session digest from env; keep that observed shape.
      [HOST_PROXY_SESSION_LABEL]: sessionDigest("current-session"),
      [CREATE_CONFIG_LABEL]:
        commonContainerLabels(plan, legacyEnvOverlay)[CREATE_CONFIG_LABEL] ?? "v3:legacy",
    };
    const legacyBindSources = {
      "/run/lando/host-proxy.sock": "/home/user/session/host-proxy.sock",
      // credentials bind absent on the running container
    };
    // When the new trusted overlay is desired.
    const reasons = bringUpRecreateReasons(
      plan,
      overlay,
      { labels: legacyLabels, bindSources: legacyBindSources },
      { skipAbsentFields: true },
    );
    // Then missing credentials bind and/or create-config drift force recreation (upgrade path).
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.some((reason) => reason === "bind-source" || reason === "config")).toBe(true);
    // And the legacy plan itself never arms extension-gated bind checks.
    expect(
      bringUpRecreateReasons(
        plan,
        legacyEnvOverlay,
        {
          labels: commonContainerLabels(plan, legacyEnvOverlay),
          bindSources: {
            "/run/lando/host-proxy.sock": "/home/user/other/host-proxy.sock",
          },
        },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
  });

  test("keeps matching sessions and skips absent inspect labels", () => {
    expect(
      bringUpRecreateReasons(
        plan,
        overlay,
        { labels: commonContainerLabels(plan, overlay) },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
    expect(bringUpRecreateReasons(plan, overlay, {}, { skipAbsentFields: true })).toEqual([]);
  });

  test("does not impose a session check without a trusted host-proxy extension", () => {
    expect(
      bringUpRecreateReasons(
        plan,
        service,
        { labels: commonContainerLabels(plan, service) },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
    expect(
      bringUpRecreateReasons(
        plan,
        legacyEnvOverlay,
        {
          labels: {
            ...commonContainerLabels(plan, legacyEnvOverlay),
            [HOST_PROXY_SESSION_LABEL]: sessionDigest("other"),
          },
        },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
  });

  test("preserves the session marker through physical-to-logical fingerprint presentation", () => {
    const physical = {
      ...plan,
      services: { [overlay.name]: overlay },
      networking: { perAppBridge: { name: "physical", driver: "bridge" } },
    };
    const logical = { ...plan, services: { [overlay.name]: overlay } };
    const previous: ServicePlan = {
      ...overlay,
      extensions: trustedExtension("previous-session"),
    };
    const presented = presentLogicalCreateConfig(commonContainerLabels(physical, previous), {
      physical,
      logical,
      service: overlay.name,
    });
    expect(presented[CREATE_CONFIG_LABEL]).toBe(commonContainerLabels(logical, overlay)[CREATE_CONFIG_LABEL]);
    expect(presented[HOST_PROXY_SESSION_LABEL]).toBe(sessionDigest("previous-session"));
    expect(
      bringUpRecreateReasons(logical, overlay, { labels: presented }, { skipAbsentFields: true }),
    ).toEqual(["bind-source"]);
  });
});

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
  test("reports a missing authored network only for its member", () => {
    // Given a member and a non-member both connected to their default networks.
    const worker = { ...service, name: ServiceName.make("worker") };
    const app = {
      ...plan,
      networking: landoNetworkingPlan({
        slug: plan.slug,
        serviceNames: [service.name, worker.name],
        sharedCrossAppNetwork: true,
        authoredNetworks: [{ key: "extra", external: false, members: { web: [] } }],
      }),
    };
    const snapshot = { networkNames: ["lando-recreate-reasons", "lando_bridge_network"] };
    // When / Then only the service joining the missing network must recreate.
    expect(bringUpRecreateReasons(app, service, snapshot, { skipAbsentFields: true })).toEqual(["network"]);
    expect(bringUpRecreateReasons(app, worker, snapshot, { skipAbsentFields: true })).toEqual([]);
  });
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

  test("recreates when publication bindAddress changes on a running container", () => {
    // Given a running container published on loopback.
    const running = service;
    const desired: ServicePlan = {
      ...service,
      endpoints: [
        {
          _tag: "published",
          port: 8080,
          protocol: "http",
          name: "http",
          publication: { bindAddress: "0.0.0.0", hostPort: 18080 },
        },
      ],
    };
    const snapshot = { labels: commonContainerLabels(plan, running) };
    // When the desired bind changes.
    const reasons = bringUpRecreateReasons(
      { ...plan, services: { [desired.name]: desired } },
      desired,
      snapshot,
    );
    // Then create-config mismatch recreates the container.
    expect(reasons).toEqual(["config"]);
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
      mounts: [{ type: "volume", store: "agent-volume", target, readOnly: false }],
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
      mounts: [
        {
          type: "volume",
          store: "database-data",
          target: PortablePath.make("/var/lib/database"),
          readOnly: false,
        },
      ],
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
