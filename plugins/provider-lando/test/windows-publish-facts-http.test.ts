import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeRuntimeProvider } from "@lando/provider-lando";
import { AbsolutePath } from "@lando/sdk/schema";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

import type { PodmanMachineRunner } from "../src/setup.ts";

const networkId = "3aedd499152655a20462dcc5c661a54070e0677a5a1b40ab1a323300bf0dd0a1";
const networkName = "lando-vm-generation";
const containerBody = JSON.stringify({
  Id: "router",
  Config: { Labels: { "dev.lando.app": "global", "dev.lando.service": "traefik" } },
  State: { Running: false },
  HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] } },
  NetworkSettings: { Networks: { [networkName]: { NetworkID: networkId, IPAddress: "" } } },
});
const networkBody = JSON.stringify({
  Id: networkId,
  Name: networkName,
  IPAM: { Config: [{ Subnet: "10.89.3.0/24" }] },
  Containers: {},
});
const networkListBody = JSON.stringify([{ Id: networkId }]);

const machine = {
  inspect: Effect.succeed("running"),
  createdAt: Effect.succeed("created"),
  create: Effect.void,
  publishedRuleSnapshot: Effect.succeed({
    kernelBootId: "00000000-0000-0000-0000-000000000001",
    nftJson: JSON.stringify({ nftables: [] }),
  }),
  deletePublishedRule: () => Effect.void,
  hostPortOwners: (ports: ReadonlyArray<number>) =>
    Effect.succeed(new Map(ports.map((port) => [port, "wslrelay" as const]))),
  matchingPublishPorts: (ports: ReadonlyArray<number>) => Effect.succeed(ports),
  start: Effect.void,
  stop: Effect.void,
  upgrade: Effect.void,
  teardown: Effect.void,
} as PodmanMachineRunner;

const makeHarness = async (
  bodies: {
    readonly container?: string;
    readonly network?: string;
    readonly networkList?: string;
  } = {},
) => {
  const calls: string[] = [];
  const api = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: ({ path }: { readonly path: string }) => {
      calls.push(path);
      const body =
        path === "/containers/router/json"
          ? (bodies.container ?? containerBody)
          : path === `/networks/${networkName}`
            ? (bodies.network ?? networkBody)
            : path === "/networks"
              ? (bodies.networkList ?? networkListBody)
              : undefined;
      return body === undefined
        ? Effect.succeed({ status: 404, body: "" })
        : Effect.succeed({ status: 200, body });
    },
  } as PodmanApiClient;
  const stateStore = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make("/tmp/windows-published-facts-http"),
    ownerOnlyFileAccess,
  );
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      sanitizeAppliedPlan: stripHostProxyRunLando,
      platform: "win32",
      providerSocketPath: "\\\\.\\pipe\\podman-lando",
      podmanApi: api,
      podmanMachine: machine,
      appliedPlanState: stateStore,
    }),
  );
  if (provider.matchingPublishPorts === undefined) throw new Error("matchingPublishPorts unavailable");
  return { calls, match: provider.matchingPublishPorts };
};

describe("Windows published facts production HTTP adapter", () => {
  test("uses Docker-compatible container, named-network, and network-list requests", async () => {
    const harness = await makeHarness();

    const matched = await Effect.runPromise(harness.match("router", [38080]));

    expect(matched).toEqual([]);
    expect(harness.calls).toEqual(["/containers/router/json", `/networks/${networkName}`, "/networks"]);
  });

  test("fails closed for a missing attachment or missing network inventory", async () => {
    const missingAttachment = await makeHarness({
      container: JSON.stringify({
        Id: "router",
        Config: { Labels: { "dev.lando.app": "global", "dev.lando.service": "traefik" } },
        NetworkSettings: { Networks: {} },
      }),
    });
    const attachmentResult = await Effect.runPromise(
      Effect.either(missingAttachment.match("router", [38080])),
    );
    expect(Either.isLeft(attachmentResult)).toBe(true);
    if (Either.isLeft(attachmentResult)) {
      const error = attachmentResult.left;
      if (error._tag !== "ProviderUnavailableError") throw new Error(`Unexpected ${error._tag}`);
      expect(error.operation).toBe("matchingPublishPorts");
    }
    expect(missingAttachment.calls).toEqual(["/containers/router/json"]);

    const missingInventory = await makeHarness({ networkList: "[]" });
    const inventoryResult = await Effect.runPromise(Effect.either(missingInventory.match("router", [38080])));
    expect(Either.isLeft(inventoryResult)).toBe(true);
    if (Either.isLeft(inventoryResult)) {
      const error = inventoryResult.left;
      if (error._tag !== "ProviderUnavailableError") throw new Error(`Unexpected ${error._tag}`);
      expect(error.operation).toBe("matchingPublishPorts");
    }
  });

  test.each([
    ["container", { container: "{" }],
    ["network", { network: "null" }],
    ["network inventory", { networkList: "null" }],
  ] as const)("tags malformed %s bodies", async (_label, bodies) => {
    const harness = await makeHarness(bodies);

    const result = await Effect.runPromise(Effect.either(harness.match("router", [38080])));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const error = result.left;
      if (error._tag !== "ProviderUnavailableError") throw new Error(`Unexpected ${error._tag}`);
      expect(error.operation).toBe("matchingPublishPorts");
    }
  });
});
