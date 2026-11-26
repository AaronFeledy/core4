import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
  landoServiceNetworkAttachments,
} from "@lando/sdk/schema";
import { DateTime } from "effect";

import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { HOST_PROXY_CONTRACT_LABEL, HOST_PROXY_TRANSPORT_EXTENSION_KEY } from "../src/labels.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUpRecreateReasons } from "../src/podman/bring-up-recreate.ts";

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
      kind: "published",
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

test.each([
  [undefined, true, ["config"]],
  [true, false, ["config"]],
  [true, true, []],
] as const)("reconciles init %s to %s", (before, after, expected) => {
  // Given
  const previous = { ...service, ...(before === undefined ? {} : { init: before }) };
  const desired = { ...service, init: after };
  // When
  const reasons = bringUpRecreateReasons(plan, desired, {
    labels: commonContainerLabels(plan, previous),
  });
  // Then
  expect(reasons).toEqual([...expected]);
});

describe("host-proxy contract reconciliation", () => {
  const contractDigest = (contract: string): string => sha256Hex(contract).slice(0, 16);
  const withContract = (contract: string): ServicePlan => ({
    ...service,
    environment: {
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy/sock",
      LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      LANDO_HOST_PROXY_DEPTH: "0",
    },
    mounts: [
      {
        type: "bind",
        source: "/home/user/run/app/container",
        target: PortablePath.make("/run/lando/host-proxy"),
        readOnly: true,
        realization: "passthrough",
      },
    ],
    extensions: { [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { contractDigest: contractDigest(contract) } },
  });
  const overlay = withContract("current");
  /** Env overlay observed on containers created by builds without the transport extension. */
  const legacyEnvOverlay: ServicePlan = {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SESSION: "current-session",
      LANDO_HOST_PROXY_TOKEN: "token-1",
      LANDO_HOST_PROXY_APP: "app-1",
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
    },
  };

  test("emits only a trusted extension digest and excludes it from create-config", () => {
    // When labels are projected for two contracts of the same service configuration.
    const labels = commonContainerLabels(plan, overlay);
    // Then the digest comes from the extension, never from env, and create-config ignores it.
    expect(labels[HOST_PROXY_CONTRACT_LABEL]).toBe(contractDigest("current"));
    expect(labels[CREATE_CONFIG_LABEL]).toBe(
      commonContainerLabels(plan, withContract("other"))[CREATE_CONFIG_LABEL],
    );
    expect(commonContainerLabels(plan, service)[HOST_PROXY_CONTRACT_LABEL]).toBeUndefined();
    expect(commonContainerLabels(plan, legacyEnvOverlay)[HOST_PROXY_CONTRACT_LABEL]).toBeUndefined();
  });

  test("keeps a container whose contract is unchanged", () => {
    // Given a container created under the same contract, whatever session it served.
    const labels = commonContainerLabels(plan, overlay);
    // When / Then the container stays, so a replaced worker never recreates it.
    expect(bringUpRecreateReasons(plan, overlay, { labels })).toEqual([]);
  });

  test.each([
    ["a changed contract", commonContainerLabels(plan, withContract("previous")), overlay],
    ["an enabled overlay", commonContainerLabels(plan, service), overlay],
    ["a disabled overlay", commonContainerLabels(plan, overlay), service],
  ] as const)("recreates for %s as bind-source drift", (_case, labels, desired) => {
    // When bring-up compares the container's contract label with the desired service.
    const reasons = bringUpRecreateReasons(plan, desired, { labels });
    // Then only the host-proxy binds drift; the create configuration does not.
    expect(reasons).toEqual(["bind-source"]);
  });

  test("an authored label cannot keep a container that carries a stale overlay", () => {
    // Given a forged Compose label matching the observed digest but no transport extension.
    const spoofed: ServicePlan = {
      ...service,
      extensions: { compose: { labels: { [HOST_PROXY_CONTRACT_LABEL]: contractDigest("current") } } },
    };
    const labels = commonContainerLabels(plan, spoofed);
    // When / Then the marker is stripped, so the overlay container still recreates.
    expect(labels[HOST_PROXY_CONTRACT_LABEL]).toBeUndefined();
    expect(
      bringUpRecreateReasons(plan, spoofed, {
        labels: { ...labels, [HOST_PROXY_CONTRACT_LABEL]: contractDigest("current") },
      }),
    ).toEqual(["bind-source"]);
  });

  test("recreates a container from a build without a contract label", () => {
    // Given an older container that only had the session env and no contract label.
    const legacyLabels = {
      [CREATE_CONFIG_LABEL]:
        commonContainerLabels(plan, legacyEnvOverlay)[CREATE_CONFIG_LABEL] ?? "v3:legacy",
    };
    // When / Then the missing contract and the stale configuration both require recreation.
    expect(bringUpRecreateReasons(plan, overlay, { labels: legacyLabels })).toEqual([
      "bind-source",
      "config",
    ]);
    expect(bringUpRecreateReasons(plan, overlay, {})).toEqual(["bind-source", "config"]);
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
    expect(
      bringUpRecreateReasons(app, service, {
        ...snapshot,
        labels: commonContainerLabels(app, service),
      }),
    ).toEqual(["network"]);
    expect(
      bringUpRecreateReasons(app, worker, {
        ...snapshot,
        labels: commonContainerLabels(app, worker),
      }),
    ).toEqual([]);
  });
  test("reports known missing config labels", () => {
    // Given known-empty labels from a real container inspect.
    const snapshot = { labels: {} };
    // When preflight compares the desired config.
    const reasons = bringUpRecreateReasons(plan, service, snapshot);
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
          kind: "published",
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
    const reasons = bringUpRecreateReasons(plan, service, snapshot);
    // Then no recreation is needed.
    expect(reasons).toEqual([]);
  });
  test("keeps a container when inspect reports matching evidence for every field", () => {
    expect(
      bringUpRecreateReasons(plan, service, {
        publishFingerprint: "8080/tcp@127.0.0.1:18080",
        bindSources: {},
        networkNames: landoServiceNetworkAttachments(plan, service).map(({ name }) => name),
        labels: commonContainerLabels(plan, service),
      }),
    ).toEqual([]);
  });

  test("reports publish-port, bind-source, and network drift when snapshot fields are present", () => {
    expect(
      bringUpRecreateReasons(plan, service, {
        publishFingerprint: "8080/tcp@127.0.0.1:18081",
        bindSources: { "/run/lando/ssh-agent": "bind:/tmp/old" },
        networkNames: ["unrelated"],
        labels: commonContainerLabels(plan, service),
      }),
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
      bringUpRecreateReasons(plan, withAppMount, {
        bindSources: {
          "/app": "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app",
        },
        labels: commonContainerLabels(plan, withAppMount),
      }),
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
    const labels = commonContainerLabels(plan, sidecar);
    expect(bringUpRecreateReasons(plan, sidecar, { bindSources: {}, labels })).toEqual(["bind-source"]);
    expect(
      bringUpRecreateReasons(plan, sidecar, {
        bindSources: { [target]: "volume:agent-volume" },
        labels,
      }),
    ).toEqual([]);
    expect(
      bringUpRecreateReasons(plan, sidecar, {
        bindSources: { [target]: "volume:previous-volume" },
        labels,
      }),
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
      bringUpRecreateReasons(plan, dataService, {
        bindSources: {},
        labels: commonContainerLabels(plan, dataService),
      }),
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
    bringUpRecreateReasons(plan, ordinary, {
      bindSources: { "/ssh-auth": "/previous/auth" },
      labels: commonContainerLabels(plan, ordinary),
    }),
  ).toEqual([]);
});
