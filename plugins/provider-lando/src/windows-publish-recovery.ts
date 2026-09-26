import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";

import {
  type PublishedContainerReceipt,
  type PublishedOwnerSnapshot,
  currentPublishedRules,
  dnatChainForNetwork,
  loadPublishedContainerReceipt,
  parseExactPublishedRules,
  receiptMatchesOwner,
  savePublishedContainerReceipt,
  staleReceiptHandles,
} from "./windows-nft-receipt.ts";
import { validIpv4Address, windowsSharedDnatClaims } from "./windows-publish-claims.ts";

export const withPublishedRecoveryAfterLifecycle = <A, E, R, E2, R2>(
  action: "start" | "stop" | "restart",
  lifecycle: Effect.Effect<A, E, R>,
  reconcile: Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  action === "start" || action === "restart" ? lifecycle.pipe(Effect.tap(() => reconcile)) : lifecycle;
export const compatNetworkIds = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) throw new Error("Podman network list is not an array.");
  const ids = value.map((entry) => {
    const network = jsonRecord(entry);
    if (network === undefined || typeof network.Id !== "string" || !/^[a-f0-9]{64}$/u.test(network.Id))
      throw new Error("Podman network list entry has no valid Id.");
    return network.Id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Podman network list contains duplicate identities.");
  return ids;
};
export const WINDOWS_COMPAT_NETWORK_LIST_PATH = "/networks" as const;

export const supportsWindowsPublishedRecovery = (input: {
  readonly appId: string;
  readonly networks?: unknown;
  readonly endpoints: ReadonlyArray<{
    readonly _tag: string;
    readonly protocol?: string;
    readonly publication?: { readonly bindAddress?: string | undefined } | undefined;
  }>;
}): boolean => {
  const published = input.endpoints.filter((endpoint) => endpoint._tag === "published");
  return (
    input.appId === "global" &&
    published.length > 0 &&
    published.length === input.endpoints.length &&
    published.every(
      (endpoint) => endpoint.protocol !== "udp" && endpoint.publication?.bindAddress === "127.0.0.1",
    ) &&
    (input.networks === undefined ||
      (typeof input.networks === "object" &&
        input.networks !== null &&
        !Array.isArray(input.networks) &&
        Object.keys(input.networks).length <= 1))
  );
};
export const publishedFactsFromCompatResponses = (input: {
  readonly containerBody: string;
  readonly networkBody: string;
  readonly networkListBody: string;
  readonly machineCreated: string;
  readonly kernelBootId: string;
}): WindowsPublishedFacts => {
  const container: unknown = JSON.parse(input.containerBody);
  const network: unknown = JSON.parse(input.networkBody);
  const networkList: unknown = JSON.parse(input.networkListBody);
  const networkRecord = jsonRecord(network);
  if (networkRecord === undefined) throw new Error("Podman network inspect is not an object.");
  return publishedFactsFromPodman({
    container,
    network: { ...networkRecord, allNetworkIds: compatNetworkIds(networkList) },
    machineCreated: input.machineCreated,
    kernelBootId: input.kernelBootId,
  });
};
export interface WindowsPublishedFacts extends PublishedOwnerSnapshot {
  readonly running: boolean;
  /** Every visible network ID; chain ownership fails closed on a prefix collision. */
  readonly visibleNetworkIds: ReadonlyArray<string>;
}

type JsonRecord = Record<string, unknown>;
const jsonRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;

export const publishedFactsFromPodman = (input: {
  readonly container: unknown;
  readonly network: unknown;
  readonly machineCreated: string;
  readonly kernelBootId: string;
}): WindowsPublishedFacts => {
  const container = jsonRecord(input.container);
  const config = jsonRecord(container?.Config);
  const labels = jsonRecord(config?.Labels);
  const state = jsonRecord(container?.State);
  const host = jsonRecord(container?.HostConfig);
  const bindings = jsonRecord(host?.PortBindings);
  const settings = jsonRecord(container?.NetworkSettings);
  const networks = jsonRecord(settings?.Networks);
  const entries = networks === undefined ? [] : Object.entries(networks);
  if (
    typeof container?.Id !== "string" ||
    typeof labels?.["dev.lando.app"] !== "string" ||
    typeof labels?.["dev.lando.service"] !== "string" ||
    entries.length !== 1 ||
    bindings === undefined
  )
    throw new Error("Published container metadata is incomplete.");
  const [networkName, attachmentValue] = entries[0] ?? [];
  const attachment = jsonRecord(attachmentValue);
  if (
    networkName === undefined ||
    typeof attachment?.NetworkID !== "string" ||
    typeof attachment.IPAddress !== "string"
  )
    throw new Error("Published container network attachment is incomplete.");
  const network = jsonRecord(input.network);
  const ipam = jsonRecord(network?.IPAM);
  const subnets = ipam?.Config;
  const subnet = Array.isArray(subnets) ? jsonRecord(subnets[0])?.Subnet : undefined;
  if (network?.Id !== attachment.NetworkID || network?.Name !== networkName || typeof subnet !== "string")
    throw new Error("Published container network identity changed.");
  if (state?.Running === true && attachment.IPAddress.length === 0)
    throw new Error("Running published container has no network address.");
  const publishedPorts = Object.entries(bindings).flatMap(([key, rows]) => {
    const match = /^(\d+)\/tcp$/u.exec(key);
    if (match === null || !Array.isArray(rows) || rows.length !== 1) return [];
    const row = jsonRecord(rows[0]);
    const hostPort = Number(row?.HostPort);
    const containerPort = Number(match[1]);
    return row?.HostIp === "127.0.0.1" &&
      Number.isInteger(hostPort) &&
      hostPort > 0 &&
      hostPort <= 65535 &&
      Number.isInteger(containerPort) &&
      containerPort > 0 &&
      containerPort <= 65535
      ? [{ hostPort, containerPort }]
      : [];
  });
  if (publishedPorts.length !== Object.keys(bindings).length || publishedPorts.length === 0)
    throw new Error("Published container bindings are ambiguous.");
  const liveAddresses = new Set<string>();
  const networkContainers = jsonRecord(network?.Containers);
  if (networkContainers === undefined) throw new Error("Podman network container inventory is missing.");
  for (const attached of Object.values(networkContainers)) {
    const addressWithPrefix = jsonRecord(attached)?.IPv4Address;
    if (typeof addressWithPrefix !== "string")
      throw new Error("Podman network address inventory is malformed.");
    const [address] = addressWithPrefix.split("/");
    if (address === undefined || !validIpv4Address(address))
      throw new Error("Podman network address is invalid.");
    liveAddresses.add(address);
  }
  const visibleNetworkIds = Array.isArray(network?.allNetworkIds)
    ? network.allNetworkIds.filter((id): id is string => typeof id === "string")
    : [attachment.NetworkID];
  return {
    machineCreated: input.machineCreated,
    kernelBootId: input.kernelBootId,
    networkId: attachment.NetworkID,
    networkName,
    subnet,
    containerId: container.Id,
    appId: labels["dev.lando.app"],
    serviceId: labels["dev.lando.service"],
    containerAddress: attachment.IPAddress,
    publishedPorts,
    liveAddresses,
    visibleNetworkIds,
    running: state?.Running === true,
  };
};
export interface WindowsPublishedRecoveryDeps {
  readonly stateStore: PluginStateStore;
  readonly facts: (containerId: string) => Effect.Effect<WindowsPublishedFacts, unknown>;
  readonly machineCreated: Effect.Effect<string, unknown>;
  readonly guestSnapshot: Effect.Effect<{ readonly kernelBootId: string; readonly nftJson: string }, unknown>;
  readonly hostPortOwners: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyMap<number, "free" | "wslrelay" | "foreign">, unknown>;
  readonly deleteRule: (chain: string, handle: number) => Effect.Effect<void, unknown>;
}

const failure = (operation: string, message: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message,
    remediation:
      "Check the Lando-owned Podman machine and its published-port rules. Lando will not change ambiguous shared WSL firewall rules.",
    ...(cause === undefined ? {} : { cause }),
  });

const ensureUniqueChain = (facts: WindowsPublishedFacts): void => {
  const prefix = facts.networkId.slice(0, 8);
  if (facts.visibleNetworkIds.filter((id) => id.startsWith(prefix)).length !== 1)
    throw new Error("Podman network ID prefix is ambiguous.");
};

const hostAllowsOwnedPair = (
  ports: ReadonlyArray<number>,
  owners: ReadonlyMap<number, "free" | "wslrelay" | "foreign">,
): boolean => ports.every((port) => owners.get(port) === "free" || owners.get(port) === "wslrelay");

const exclusiveClaims = (
  raw: string,
  allowedByHostPort: ReadonlyMap<number, ReadonlySet<string>>,
  requireEachPort = false,
): boolean => {
  const claims = windowsSharedDnatClaims(raw);
  return [...allowedByHostPort].every(([hostPort, allowed]) => {
    const targets = claims.get(hostPort);
    if (targets === undefined || targets.size === 0) return !requireEachPort;
    return [...targets].every((endpoint) => allowed.has(endpoint));
  });
};

const receiptEndpointsByHostPort = (
  receipt: PublishedContainerReceipt,
  current?: WindowsPublishedFacts,
): ReadonlyMap<number, ReadonlySet<string>> =>
  new Map(
    receipt.rules.map((rule) => [
      rule.hostPort,
      new Set([
        `${rule.containerAddress}:${rule.containerPort}`,
        ...(current === undefined ? [] : [`${current.containerAddress}:${rule.containerPort}`]),
      ]),
    ]),
  );

const currentClaimOnly = (raw: string, facts: WindowsPublishedFacts): boolean => {
  const claims = windowsSharedDnatClaims(raw);
  return facts.publishedPorts.every((published) => {
    const targets = claims.get(published.hostPort);
    return (
      targets !== undefined &&
      targets.size === 1 &&
      targets.has(`${facts.containerAddress}:${published.containerPort}`)
    );
  });
};

const sameIdentity = (receipt: PublishedContainerReceipt, facts: WindowsPublishedFacts): boolean =>
  receiptMatchesOwner(receipt, facts);

export const makeWindowsPublishedRecovery = (deps: WindowsPublishedRecoveryDeps) => {
  const readFacts = (containerId: string) =>
    Effect.gen(function* () {
      const [facts, created, guest] = yield* Effect.all([
        deps.facts(containerId),
        deps.machineCreated,
        deps.guestSnapshot,
      ]);
      if (facts.machineCreated !== created || facts.kernelBootId !== guest.kernelBootId)
        return yield* Effect.fail(new Error("Machine generation changed during port verification."));
      return yield* Effect.try({
        try: () => {
          ensureUniqueChain(facts);
          const chain = dnatChainForNetwork(facts.networkId, facts.subnet);
          return { facts, guest, chain, rules: parseExactPublishedRules(guest.nftJson, chain) };
        },
        catch: (cause) =>
          failure("publishedPortFacts", "Published-port ownership metadata is invalid.", cause),
      });
    });

  const validate = <A>(operation: string, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => failure(operation, "Published-port ownership validation failed.", cause),
    });
  const matchingPorts = (containerId: string, requested: ReadonlyArray<number>) =>
    deps.stateStore
      .withLock(
        "windows-published-container-recovery",
        Effect.gen(function* () {
          const { facts, guest, rules } = yield* readFacts(containerId);
          const configured = new Set(facts.publishedPorts.map((port) => port.hostPort));
          if (requested.some((port) => !configured.has(port))) return [];
          const owners = yield* deps.hostPortOwners(requested);
          if (!hostAllowsOwnedPair(requested, owners)) return [];
          const receipt = yield* loadPublishedContainerReceipt(deps.stateStore, facts.appId, facts.serviceId);
          if (facts.running) {
            const owned = yield* validate("matchingPublishPorts", () => {
              if (receipt !== undefined && sameIdentity(receipt, facts)) {
                const staleHandles = staleReceiptHandles(receipt, facts, rules);
                if (staleHandles.length > 0)
                  return exclusiveClaims(guest.nftJson, receiptEndpointsByHostPort(receipt, facts), true);
              }
              currentPublishedRules(facts, rules);
              return currentClaimOnly(guest.nftJson, facts);
            });
            return owned ? requested : [];
          }
          if (receipt === undefined || !sameIdentity(receipt, facts)) return [];
          const reserved = yield* validate("matchingPublishPorts", () =>
            exclusiveClaims(guest.nftJson, receiptEndpointsByHostPort(receipt)),
          );
          return reserved ? requested : [];
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          failure("matchingPublishPorts", "Unable to validate an owned Windows published-port pair.", cause),
        ),
      );

  const reconcileAndRecord = (containerId: string) =>
    deps.stateStore
      .withLock(
        "windows-published-container-recovery",
        Effect.gen(function* () {
          const before = yield* readFacts(containerId);
          const { facts } = before;
          if (!facts.running || facts.publishedPorts.length === 0)
            return yield* Effect.fail(new Error("Published container is not running."));
          const receipt = yield* loadPublishedContainerReceipt(deps.stateStore, facts.appId, facts.serviceId);
          if (receipt !== undefined && sameIdentity(receipt, facts)) {
            const handles = yield* Effect.try({
              try: () => staleReceiptHandles(receipt, facts, before.rules),
              catch: (cause) =>
                failure("reconcilePublishedPorts", "The prior published-port receipt is invalid.", cause),
            });
            for (const handle of handles) {
              const fresh = yield* readFacts(containerId);
              if (
                !sameIdentity(receipt, fresh.facts) ||
                !fresh.facts.running ||
                fresh.facts.containerAddress !== facts.containerAddress ||
                !(yield* Effect.try({
                  try: () => staleReceiptHandles(receipt, fresh.facts, fresh.rules).includes(handle),
                  catch: (cause) => failure("reconcilePublishedPorts", "The published rule changed.", cause),
                }))
              )
                return yield* Effect.fail(new Error("Published rule changed before scoped cleanup."));
              const ports = fresh.facts.publishedPorts.map((port) => port.hostPort);
              const owners = yield* deps.hostPortOwners(ports);
              const exclusive = yield* validate("reconcilePublishedPorts", () =>
                exclusiveClaims(fresh.guest.nftJson, receiptEndpointsByHostPort(receipt, fresh.facts), true),
              );
              if (!hostAllowsOwnedPair(ports, owners) || !exclusive)
                return yield* Effect.fail(new Error("A foreign host or guest publication claimed the port."));
              yield* deps.deleteRule(fresh.chain, handle);
            }
          }
          const after = yield* readFacts(containerId);
          const currentExclusive = yield* validate("reconcilePublishedPorts", () =>
            currentClaimOnly(after.guest.nftJson, after.facts),
          );
          if (
            !after.facts.running ||
            after.facts.containerAddress !== facts.containerAddress ||
            !currentExclusive
          )
            return yield* Effect.fail(new Error("Current published-port mapping is not exclusive."));
          const rules = yield* Effect.try({
            try: () => currentPublishedRules(after.facts, after.rules),
            catch: (cause) =>
              failure("reconcilePublishedPorts", "The current published mapping is invalid.", cause),
          });
          yield* savePublishedContainerReceipt(deps.stateStore, {
            machineCreated: after.facts.machineCreated,
            kernelBootId: after.facts.kernelBootId,
            networkId: after.facts.networkId,
            networkName: after.facts.networkName,
            subnet: after.facts.subnet,
            containerId: after.facts.containerId,
            appId: after.facts.appId,
            serviceId: after.facts.serviceId,
            containerAddress: after.facts.containerAddress,
            rules,
          });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          failure(
            "reconcilePublishedPorts",
            "Unable to reconcile the Lando-owned Windows port mapping.",
            cause,
          ),
        ),
      );

  return { matchingPorts, reconcileAndRecord };
};
