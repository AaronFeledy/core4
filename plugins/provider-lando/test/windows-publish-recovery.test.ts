import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

import { savePublishedContainerReceipt } from "../src/windows-nft-receipt.ts";
import {
  WINDOWS_COMPAT_NETWORK_LIST_PATH,
  type WindowsPublishedFacts,
  compatNetworkIds,
  makeWindowsPublishedRecovery,
  publishedFactsFromCompatResponses,
  publishedFactsFromPodman,
  supportsWindowsPublishedRecovery,
  withPublishedRecoveryAfterLifecycle,
} from "../src/windows-publish-recovery.ts";

const chain = "nv_3aedd499_10_89_3_0_nm24_dnat";
const networkId = "3aedd499152655a20462dcc5c661a54070e0677a5a1b40ab1a323300bf0dd0a1";
const rule = (handle: number, hostPort: number, address: string, containerPort: number) => ({
  rule: {
    family: "inet",
    table: "netavark",
    chain,
    handle,
    expr: [
      { match: { op: "==", left: { payload: { protocol: "ip", field: "daddr" } }, right: "127.0.0.1" } },
      { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: hostPort } },
      { mangle: { key: { ct: { key: "mark" } }, value: { "|": [{ meta: { key: "mark" } }, 4096] } } },
      { dnat: { family: "ip", addr: address, port: containerPort } },
    ],
  },
});
const base = {
  machineCreated: "created",
  kernelBootId: "00000000-0000-0000-0000-000000000001",
  networkId,
  networkName: "lando-vm-generation",
  subnet: "10.89.3.0/24",
  containerId: "router",
  appId: "global",
  serviceId: "traefik",
  publishedPorts: [
    { hostPort: 38080, containerPort: 80 },
    { hostPort: 28443, containerPort: 443 },
  ],
  visibleNetworkIds: [networkId],
};
const oldRules = [
  { handle: 1, chain, hostPort: 38080, containerAddress: "10.89.3.8", containerPort: 80 },
  { handle: 2, chain, hostPort: 28443, containerAddress: "10.89.3.8", containerPort: 443 },
];

test("refreshes published ownership after start and restart but not stop", async () => {
  for (const action of ["start", "restart", "stop"] as const) {
    const events: string[] = [];
    await Effect.runPromise(
      withPublishedRecoveryAfterLifecycle(
        action,
        Effect.sync(() => events.push(action)),
        Effect.sync(() => events.push("reconcile")),
      ),
    );
    expect(events).toEqual(action === "stop" ? ["stop"] : [action, "reconcile"]);
  }
});
test("limits optional recovery to managed global loopback TCP publications", () => {
  const endpoint = {
    _tag: "published",
    protocol: "http",
    publication: { bindAddress: "127.0.0.1" },
  };
  expect(supportsWindowsPublishedRecovery({ appId: "global", endpoints: [endpoint] })).toBe(true);
  expect(
    supportsWindowsPublishedRecovery({
      appId: "global",
      endpoints: [{ ...endpoint, publication: { bindAddress: "0.0.0.0" } }],
    }),
  ).toBe(false);
  expect(
    supportsWindowsPublishedRecovery({
      appId: "global",
      endpoints: [{ ...endpoint, protocol: "udp" }],
    }),
  ).toBe(false);
  expect(
    supportsWindowsPublishedRecovery({
      appId: "global",
      networks: { one: {}, two: {} },
      endpoints: [endpoint],
    }),
  ).toBe(false);
  expect(supportsWindowsPublishedRecovery({ appId: "user-app", endpoints: [endpoint] })).toBe(false);
});
test("uses strict Docker-compatible network responses from the production endpoint", () => {
  expect(WINDOWS_COMPAT_NETWORK_LIST_PATH).toBe("/networks");
  expect(compatNetworkIds([{ Id: networkId }])).toEqual([networkId]);
  expect(() => compatNetworkIds([{ id: networkId }])).toThrow();
  const facts = publishedFactsFromCompatResponses({
    machineCreated: "created",
    kernelBootId: base.kernelBootId,
    containerBody: JSON.stringify({
      Id: "router",
      Config: { Labels: { "dev.lando.app": "global", "dev.lando.service": "traefik" } },
      State: { Running: true },
      HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
      NetworkSettings: {
        Networks: { "lando-vm-generation": { NetworkID: networkId, IPAddress: "10.89.3.3" } },
      },
    }),
    networkBody: JSON.stringify({
      Id: networkId,
      Name: "lando-vm-generation",
      IPAM: { Config: [{ Subnet: "10.89.3.0/24" }] },
      Containers: { router: { Name: "lando-global-traefik", IPv4Address: "10.89.3.3/24" } },
    }),
    networkListBody: JSON.stringify([{ Id: networkId }]),
  });
  expect(facts.networkId).toBe(networkId);
  expect(() =>
    publishedFactsFromCompatResponses({
      machineCreated: "created",
      kernelBootId: base.kernelBootId,
      containerBody: "null",
      networkBody: "null",
      networkListBody: "null",
    }),
  ).toThrow();
});

test("Podman facts reject invalid container ports and ambiguous attachments", () => {
  const input = {
    machineCreated: "created",
    kernelBootId: base.kernelBootId,
    container: {
      Id: "router",
      Config: { Labels: { "dev.lando.app": "global", "dev.lando.service": "traefik" } },
      State: { Running: true },
      HostConfig: { PortBindings: { "65536/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
      NetworkSettings: {
        Networks: {
          "lando-vm-generation": { NetworkID: networkId, IPAddress: "10.89.3.3" },
        },
      },
    },
    network: {
      Id: networkId,
      Name: "lando-vm-generation",
      IPAM: { Config: [{ Subnet: "10.89.3.0/24" }] },
      allNetworkIds: [networkId],
      Containers: {},
    },
    allContainers: [],
  };
  expect(() => publishedFactsFromPodman(input)).toThrow();
  const stopped = publishedFactsFromPodman({
    ...input,
    container: {
      ...input.container,
      State: { Running: false },
      HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
      NetworkSettings: {
        Networks: {
          "lando-vm-generation": { NetworkID: networkId, IPAddress: "" },
        },
      },
    },
  });
  expect(stopped.running).toBe(false);
  expect(stopped.containerAddress).toBe("");
  const compatible = publishedFactsFromPodman({
    ...input,
    container: {
      ...input.container,
      HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
    },
    network: {
      ...input.network,
      Containers: { router: { Name: "lando-global-traefik", IPv4Address: "10.89.3.3/24" } },
    },
  });
  expect(compatible.liveAddresses).toEqual(new Set(["10.89.3.3"]));
  expect(() =>
    publishedFactsFromPodman({
      ...input,
      container: {
        ...input.container,
        HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
        NetworkSettings: {
          Networks: {
            "lando-vm-generation": { NetworkID: networkId, IPAddress: "10.89.3.3" },
            foreign: { NetworkID: "f".repeat(64), IPAddress: "10.77.0.2" },
          },
        },
      },
    }),
  ).toThrow();
});
describe("Windows published-port recovery", () => {
  test("reserves stopped owned pair, then removes only receipt rules and records current mapping", async () => {
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/windows-published-recovery"),
      ownerOnlyFileAccess,
    );
    await Effect.runPromise(
      savePublishedContainerReceipt(stateStore, {
        ...base,
        containerAddress: "10.89.3.8",
        rules: oldRules,
      }),
    );
    let facts: WindowsPublishedFacts = {
      ...base,
      running: false,
      containerAddress: "10.89.3.8",
      liveAddresses: new Set(),
    };
    let nft = JSON.stringify({
      nftables: [rule(1, 38080, "10.89.3.8", 80), rule(2, 28443, "10.89.3.8", 443)],
    });
    const deleted: number[] = [];
    const recovery = makeWindowsPublishedRecovery({
      stateStore,
      facts: () => Effect.succeed(facts),
      machineCreated: Effect.succeed("created"),
      guestSnapshot: Effect.sync(() => ({ kernelBootId: base.kernelBootId, nftJson: nft })),
      hostPortOwners: (ports) => Effect.succeed(new Map(ports.map((port) => [port, "wslrelay" as const]))),
      deleteRule: (_chain, handle) =>
        Effect.sync(() => {
          deleted.push(handle);
          const parsed = JSON.parse(nft) as { nftables: Array<{ rule: { handle: number } }> };
          nft = JSON.stringify({ nftables: parsed.nftables.filter((entry) => entry.rule.handle !== handle) });
        }),
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
    facts = {
      ...facts,
      running: true,
      containerAddress: "10.89.3.3",
      liveAddresses: new Set(["10.89.3.3"]),
    };
    nft = JSON.stringify({
      nftables: [
        rule(1, 38080, "10.89.3.8", 80),
        rule(2, 28443, "10.89.3.8", 443),
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
      ],
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
    nft = JSON.stringify({
      nftables: [
        rule(1, 38080, "10.89.3.8", 80),
        rule(2, 28443, "10.89.3.8", 443),
        rule(5, 38080, "10.89.3.8", 443),
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
      ],
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([]);
    nft = JSON.stringify({
      nftables: [
        rule(2, 28443, "10.89.3.8", 443),
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
      ],
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
    nft = JSON.stringify({
      nftables: [
        rule(1, 38080, "10.89.3.8", 80),
        rule(2, 28443, "10.89.3.8", 443),
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
      ],
    });
    await Effect.runPromise(recovery.reconcileAndRecord("router"));
    expect(deleted).toEqual([1, 2]);
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
    nft = JSON.stringify({
      nftables: [
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
        rule(5, 38080, "10.89.3.3", 80),
        rule(6, 28443, "10.89.3.3", 443),
      ],
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
    nft = JSON.stringify({
      nftables: [rule(3, 38080, "10.89.3.3", 80), rule(5, 38080, "10.89.3.3", 80)],
    });
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([]);
    nft = JSON.stringify({
      nftables: [
        rule(3, 38080, "10.89.3.3", 80),
        rule(4, 28443, "10.89.3.3", 443),
        rule(5, 38080, "10.89.3.3", 80),
        rule(6, 28443, "10.89.3.3", 443),
      ],
    });
    await Effect.runPromise(recovery.reconcileAndRecord("router"));
    expect(deleted).toEqual([1, 2, 3, 4]);
    expect(await Effect.runPromise(recovery.matchingPorts("router", [38080, 28443]))).toEqual([38080, 28443]);
  });

  test("returns tagged failures for malformed and unsupported shared claims", async () => {
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/windows-published-malformed"),
      ownerOnlyFileAccess,
    );
    await Effect.runPromise(
      savePublishedContainerReceipt(stateStore, {
        ...base,
        containerAddress: "10.89.3.8",
        rules: oldRules,
      }),
    );
    const facts: WindowsPublishedFacts = {
      ...base,
      running: false,
      containerAddress: "",
      liveAddresses: new Set(),
    };
    const run = async (nftJson: string) =>
      Effect.runPromise(
        Effect.either(
          makeWindowsPublishedRecovery({
            stateStore,
            facts: () => Effect.succeed(facts),
            machineCreated: Effect.succeed("created"),
            guestSnapshot: Effect.succeed({ kernelBootId: base.kernelBootId, nftJson }),
            hostPortOwners: (ports) =>
              Effect.succeed(new Map(ports.map((port) => [port, "wslrelay" as const]))),
            deleteRule: () => Effect.die("must not delete"),
          }).matchingPorts("router", [38080, 28443]),
        ),
      );
    const malformed = await run("{");
    expect(malformed._tag).toBe("Left");
    if (malformed._tag === "Left") expect(malformed.left._tag).toBe("ProviderUnavailableError");
    const redirected = await run(
      JSON.stringify({
        nftables: [
          rule(1, 38080, "10.89.3.8", 80),
          rule(2, 28443, "10.89.3.8", 443),
          {
            rule: {
              family: "ip",
              table: "nat",
              chain: "FOREIGN",
              expr: [
                { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 38080 } },
                { redirect: { port: 9999 } },
              ],
            },
          },
        ],
      }),
    );
    expect(redirected._tag).toBe("Right");
    if (redirected._tag === "Right") expect(redirected.right).toEqual([]);
  });
  test("rejects reservation when a native foreign listener or foreign guest target overlaps", async () => {
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/windows-published-conflict"),
      ownerOnlyFileAccess,
    );
    await Effect.runPromise(
      savePublishedContainerReceipt(stateStore, {
        ...base,
        containerAddress: "10.89.3.8",
        rules: oldRules,
      }),
    );
    const facts: WindowsPublishedFacts = {
      ...base,
      running: false,
      containerAddress: "10.89.3.8",
      liveAddresses: new Set(),
    };
    const make = (foreignHost: boolean, foreignGuest: boolean) =>
      makeWindowsPublishedRecovery({
        stateStore,
        facts: () => Effect.succeed(facts),
        machineCreated: Effect.succeed("created"),
        guestSnapshot: Effect.succeed({
          kernelBootId: base.kernelBootId,
          nftJson: JSON.stringify({
            nftables: [
              rule(1, 38080, "10.89.3.8", 80),
              rule(2, 28443, "10.89.3.8", 443),
              ...(foreignGuest
                ? [
                    {
                      rule: {
                        ...rule(9, 38080, "10.89.3.8", 9999).rule,
                        family: "ip",
                        table: "nat",
                        chain: "FOREIGN",
                      },
                    },
                  ]
                : []),
            ],
          }),
        }),
        hostPortOwners: (ports) =>
          Effect.succeed(
            new Map(
              ports.map((port) => [
                port,
                foreignHost && port === 38080 ? ("foreign" as const) : ("wslrelay" as const),
              ]),
            ),
          ),
        deleteRule: () => Effect.die("must not delete"),
      });
    expect(await Effect.runPromise(make(true, false).matchingPorts("router", [38080, 28443]))).toEqual([]);
    expect(await Effect.runPromise(make(false, true).matchingPorts("router", [38080, 28443]))).toEqual([]);
  });
});
