import { Effect, Schema } from "effect";

import type { PluginStateStore } from "@lando/sdk/plugins";

import { validIpv4Address } from "./windows-publish-claims.ts";

export interface PublishedRule {
  readonly handle: number;
  readonly chain: string;
  readonly hostPort: number;
  readonly containerAddress: string;
  readonly containerPort: number;
}

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;

const exactKeys = (value: RecordValue, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const exactMatch = (value: unknown, protocol: string, field: string, expected: unknown): boolean => {
  const wrapper = record(value);
  const match = record(wrapper?.match);
  const left = record(match?.left);
  const payload = record(left?.payload);
  return (
    wrapper !== undefined &&
    exactKeys(wrapper, ["match"]) &&
    match !== undefined &&
    exactKeys(match, ["op", "left", "right"]) &&
    match.op === "==" &&
    left !== undefined &&
    exactKeys(left, ["payload"]) &&
    payload !== undefined &&
    exactKeys(payload, ["protocol", "field"]) &&
    payload.protocol === protocol &&
    payload.field === field &&
    match.right === expected
  );
};

const isMarkMangle = (value: unknown): boolean => {
  const wrapper = record(value);
  const mangle = record(wrapper?.mangle);
  const key = record(mangle?.key);
  const ct = record(key?.ct);
  const expression = record(mangle?.value);
  const operands = expression?.["|"];
  const metaWrapper = Array.isArray(operands) ? record(operands[0]) : undefined;
  const meta = record(metaWrapper?.meta);
  return (
    wrapper !== undefined &&
    exactKeys(wrapper, ["mangle"]) &&
    mangle !== undefined &&
    exactKeys(mangle, ["key", "value"]) &&
    key !== undefined &&
    exactKeys(key, ["ct"]) &&
    ct !== undefined &&
    exactKeys(ct, ["key"]) &&
    ct.key === "mark" &&
    expression !== undefined &&
    exactKeys(expression, ["|"]) &&
    Array.isArray(operands) &&
    operands.length === 2 &&
    metaWrapper !== undefined &&
    exactKeys(metaWrapper, ["meta"]) &&
    meta !== undefined &&
    exactKeys(meta, ["key"]) &&
    meta.key === "mark" &&
    operands[1] === 4096
  );
};

const parseExactDnatRule = (value: unknown, chain: string): PublishedRule | undefined => {
  const wrapper = record(value);
  const rule = record(record(value)?.rule);
  if (
    wrapper === undefined ||
    !exactKeys(wrapper, ["rule"]) ||
    rule === undefined ||
    !exactKeys(rule, ["family", "table", "chain", "handle", "expr"]) ||
    rule.family !== "inet" ||
    rule.table !== "netavark" ||
    rule.chain !== chain ||
    !Number.isSafeInteger(rule.handle) ||
    (rule.handle as number) < 1
  )
    return undefined;
  const expressions = rule.expr;
  if (!Array.isArray(expressions) || expressions.length !== 4) return undefined;
  const portMatch = record(expressions[1])?.match;
  const hostPort = record(portMatch)?.right;
  if (
    !Number.isInteger(hostPort) ||
    (hostPort as number) < 1 ||
    (hostPort as number) > 65535 ||
    !exactMatch(expressions[0], "ip", "daddr", "127.0.0.1") ||
    !exactMatch(expressions[1], "tcp", "dport", hostPort) ||
    !isMarkMangle(expressions[2])
  )
    return undefined;
  const dnatWrapper = record(expressions[3]);
  const dnat = record(dnatWrapper?.dnat);
  if (
    dnatWrapper === undefined ||
    !exactKeys(dnatWrapper, ["dnat"]) ||
    dnat === undefined ||
    !exactKeys(dnat, ["family", "addr", "port"]) ||
    dnat.family !== "ip" ||
    typeof dnat.addr !== "string" ||
    !validIpv4Address(dnat.addr) ||
    !Number.isInteger(dnat.port) ||
    (dnat.port as number) < 1 ||
    (dnat.port as number) > 65535
  )
    return undefined;
  return {
    handle: rule.handle as number,
    chain,
    hostPort: hostPort as number,
    containerAddress: dnat.addr,
    containerPort: dnat.port as number,
  };
};

export const parseExactPublishedRules = (raw: string, chain: string): ReadonlyArray<PublishedRule> => {
  const parsed: unknown = JSON.parse(raw);
  const rows = record(parsed)?.nftables;
  if (!Array.isArray(rows)) throw new Error("Guest nftables JSON has no nftables array.");
  return rows.flatMap((row) => {
    const parsedRule = parseExactDnatRule(row, chain);
    return parsedRule === undefined ? [] : [parsedRule];
  });
};

export const dnatChainForNetwork = (networkId: string, subnet: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(networkId)) throw new Error("Podman network ID is invalid.");
  const match = /^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\/(\d{1,2})$/u.exec(subnet);
  if (match === null) throw new Error("Podman subnet is not IPv4 CIDR.");
  const octets = match[1]?.split(".").map(Number) ?? [];
  if (octets.length !== 4 || octets.some((octet) => octet > 255) || Number(match[2]) > 32)
    throw new Error("Podman subnet is invalid.");
  return `nv_${networkId.slice(0, 8)}_${match[1]?.replaceAll(".", "_")}_nm${match[2]}_dnat`;
};

const Ipv4AddressSchema = Schema.String.pipe(Schema.filter(validIpv4Address));
const NetworkIdSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const NftChainSchema = Schema.String.pipe(Schema.pattern(/^nv_[a-f0-9]{8}_[a-zA-Z0-9_-]+_dnat$/u));

const RuleReceiptSchema = Schema.Struct({
  handle: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  chain: NftChainSchema,
  hostPort: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)),
  containerAddress: Ipv4AddressSchema,
  containerPort: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)),
});

export const PublishedContainerReceiptSchema = Schema.Struct({
  machineCreated: Schema.String,
  kernelBootId: Schema.String,
  networkId: NetworkIdSchema,
  networkName: Schema.String,
  subnet: Schema.String,
  containerId: Schema.String,
  appId: Schema.String,
  serviceId: Schema.String,
  containerAddress: Ipv4AddressSchema,
  rules: Schema.Array(RuleReceiptSchema),
});
export type PublishedContainerReceipt = typeof PublishedContainerReceiptSchema.Type;

export const publishedReceiptKey = (appId: string, serviceId: string): string =>
  `${new Bun.CryptoHasher("sha256").update(JSON.stringify([appId, serviceId])).digest("hex")}.json`;
export const openPublishedContainerReceipt = (
  stateStore: PluginStateStore,
  appId: string,
  serviceId: string,
) =>
  stateStore.open({
    namespace: "windows-published-containers",
    key: publishedReceiptKey(appId, serviceId),
    schema: PublishedContainerReceiptSchema,
    version: 1,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "discard",
    onVersionMismatch: "discard",
  });

export const loadPublishedContainerReceipt = (
  stateStore: PluginStateStore,
  appId: string,
  serviceId: string,
) =>
  openPublishedContainerReceipt(stateStore, appId, serviceId).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((receipt) => receipt ?? undefined),
  );

export const savePublishedContainerReceipt = (
  stateStore: PluginStateStore,
  receipt: PublishedContainerReceipt,
) =>
  openPublishedContainerReceipt(stateStore, receipt.appId, receipt.serviceId).pipe(
    Effect.flatMap((bucket) => bucket.set(receipt)),
  );

export interface PublishedOwnerSnapshot {
  readonly machineCreated: string;
  readonly kernelBootId: string;
  readonly networkId: string;
  readonly networkName: string;
  readonly subnet: string;
  readonly containerId: string;
  readonly appId: string;
  readonly serviceId: string;
  readonly containerAddress: string;
  readonly publishedPorts: ReadonlyArray<{ readonly hostPort: number; readonly containerPort: number }>;
  readonly liveAddresses: ReadonlySet<string>;
}

/**
 * A receipt is only provisional ownership evidence for the same machine,
 * kernel, network, container and published ports. The caller still checks
 * Windows listener ownership and all shared-namespace nft claims.
 */
export const receiptMatchesOwner = (
  receipt: PublishedContainerReceipt,
  current: PublishedOwnerSnapshot,
): boolean =>
  receipt.machineCreated === current.machineCreated &&
  receipt.kernelBootId === current.kernelBootId &&
  receipt.networkId === current.networkId &&
  receipt.networkName === current.networkName &&
  receipt.subnet === current.subnet &&
  receipt.containerId === current.containerId &&
  receipt.appId === current.appId &&
  receipt.serviceId === current.serviceId &&
  receipt.rules.length === current.publishedPorts.length &&
  current.publishedPorts.every((port) =>
    receipt.rules.some(
      (rule) =>
        rule.hostPort === port.hostPort &&
        rule.containerPort === port.containerPort &&
        rule.containerAddress === receipt.containerAddress,
    ),
  );

export const staleReceiptHandles = (
  receipt: PublishedContainerReceipt,
  current: PublishedOwnerSnapshot,
  rules: ReadonlyArray<PublishedRule>,
): ReadonlyArray<number> => {
  if (!receiptMatchesOwner(receipt, current)) throw new Error("Published container identity changed.");
  const sameAddress = receipt.containerAddress === current.containerAddress;
  if (!sameAddress && current.liveAddresses.has(receipt.containerAddress))
    throw new Error("Previously owned address now belongs to a live container.");
  const handles: number[] = [];
  for (const recorded of receipt.rules) {
    const matching = rules.filter((rule) => rule.handle === recorded.handle);
    if (matching.length === 0) continue;
    if (
      matching.length !== 1 ||
      matching[0]?.chain !== recorded.chain ||
      matching[0]?.hostPort !== recorded.hostPort ||
      matching[0]?.containerAddress !== recorded.containerAddress ||
      matching[0]?.containerPort !== recorded.containerPort
    )
      throw new Error("Previously owned nft rule changed.");
    const replacements = rules.filter(
      (rule) =>
        rule.handle !== recorded.handle &&
        rule.chain === recorded.chain &&
        rule.hostPort === recorded.hostPort &&
        rule.containerAddress === recorded.containerAddress &&
        rule.containerPort === recorded.containerPort,
    );
    if (!sameAddress || replacements.length === 1) handles.push(recorded.handle);
    if (sameAddress && replacements.length > 1)
      throw new Error("Published mapping has ambiguous same-address replacements.");
  }
  return handles;
};

export const currentPublishedRules = (
  current: PublishedOwnerSnapshot,
  rules: ReadonlyArray<PublishedRule>,
): ReadonlyArray<PublishedRule> => {
  const chain = dnatChainForNetwork(current.networkId, current.subnet);
  const result: PublishedRule[] = [];
  for (const published of current.publishedPorts) {
    const matches = rules.filter(
      (rule) =>
        rule.chain === chain &&
        rule.hostPort === published.hostPort &&
        rule.containerAddress === current.containerAddress &&
        rule.containerPort === published.containerPort,
    );
    if (matches.length !== 1)
      throw new Error("Current published port does not have one exact owned nft rule.");
    const [matching] = matches;
    if (matching === undefined) throw new Error("Current published rule is missing.");
    result.push(matching);
  }
  return result;
};
