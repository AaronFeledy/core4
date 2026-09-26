import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  PublishedContainerReceiptSchema,
  currentPublishedRules,
  dnatChainForNetwork,
  parseExactPublishedRules,
  publishedReceiptKey,
  receiptMatchesOwner,
  staleReceiptHandles,
} from "../src/windows-nft-receipt.ts";

const chain = "nv_3aedd499_10_89_3_0_nm24_dnat";
const exactRule = (handle: number, hostPort: number, address: string, containerPort: number) => ({
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

describe("owned Windows nft publish rule parsing", () => {
  test("derives chain from full network ID and IPv4 subnet", () => {
    expect(
      dnatChainForNetwork("3aedd499152655a20462dcc5c661a54070e0677a5a1b40ab1a323300bf0dd0a1", "10.89.3.0/24"),
    ).toBe(chain);
  });

  test("accepts only exact loopback TCP DNAT shape in the owned chain", () => {
    const stale = exactRule(622, 38080, "10.89.3.8", 80);
    const current = exactRule(666, 38080, "10.89.3.3", 80);
    const udp = JSON.parse(JSON.stringify(stale));
    udp.rule.expr[1].match.left.payload.protocol = "udp";
    const wildcard = JSON.parse(JSON.stringify(stale));
    wildcard.rule.expr[0].match.right = "0.0.0.0";
    const otherChain = JSON.parse(JSON.stringify(stale));
    otherChain.rule.chain = "other";
    const extraOuter = JSON.parse(JSON.stringify(stale));
    extraOuter.rule.expr[0].comment = "unexpected";
    const extraNested = JSON.parse(JSON.stringify(stale));
    extraNested.rule.expr[2].mangle.key.ct.unexpected = true;
    expect(
      parseExactPublishedRules(
        JSON.stringify({ nftables: [stale, current, udp, wildcard, otherChain, extraOuter, extraNested] }),
        chain,
      ),
    ).toEqual([
      { handle: 622, chain, hostPort: 38080, containerAddress: "10.89.3.8", containerPort: 80 },
      { handle: 666, chain, hostPort: 38080, containerAddress: "10.89.3.3", containerPort: 80 },
    ]);
  });

  test("rejects malformed rule sets and invalid network identity", () => {
    expect(() => parseExactPublishedRules("{}", chain)).toThrow();
    expect(() => dnatChainForNetwork("bad", "10.89.3.0/24")).toThrow();
  });
});

test("receipt keys encode arbitrary identity tuples without delimiter collisions", () => {
  expect(publishedReceiptKey("foo-bar", "baz")).not.toBe(publishedReceiptKey("foo", "bar-baz"));
  expect(publishedReceiptKey("Name With / arbitrary chars", "service")).toMatch(/^[a-f0-9]{64}.json$/u);
});
describe("published-container recovery receipt", () => {
  const networkId = "3aedd499152655a20462dcc5c661a54070e0677a5a1b40ab1a323300bf0dd0a1";
  const receipt = {
    machineCreated: "2026-09-22T09:24:48Z",
    kernelBootId: "00000000-0000-0000-0000-000000000001",
    networkId,
    networkName: "lando-vm-test",
    subnet: "10.89.3.0/24",
    containerId: "owned-router-id",
    appId: "global",
    serviceId: "traefik",
    containerAddress: "10.89.3.8",
    rules: [
      { handle: 622, chain, hostPort: 38080, containerAddress: "10.89.3.8", containerPort: 80 },
      { handle: 618, chain, hostPort: 28443, containerAddress: "10.89.3.8", containerPort: 443 },
    ],
  };
  const current = {
    machineCreated: receipt.machineCreated,
    kernelBootId: receipt.kernelBootId,
    networkId,
    networkName: receipt.networkName,
    subnet: receipt.subnet,
    containerId: receipt.containerId,
    appId: receipt.appId,
    serviceId: receipt.serviceId,
    containerAddress: "10.89.3.3",
    publishedPorts: [
      { hostPort: 38080, containerPort: 80 },
      { hostPort: 28443, containerPort: 443 },
    ],
    liveAddresses: new Set(["10.89.3.3"]),
  };
  const rules = [
    ...receipt.rules,
    { handle: 666, chain, hostPort: 38080, containerAddress: "10.89.3.3", containerPort: 80 },
    { handle: 662, chain, hostPort: 28443, containerAddress: "10.89.3.3", containerPort: 443 },
  ];

  test("selects only exact archived stale handles after container address changes", () => {
    expect(staleReceiptHandles(receipt, current, rules)).toEqual([622, 618]);
    expect(currentPublishedRules(current, rules).map((rule) => rule.handle)).toEqual([666, 662]);
  });

  test("selects only receipt handles with one exact same-address replacement", () => {
    const sameAddress = {
      ...current,
      containerAddress: receipt.containerAddress,
      liveAddresses: new Set([receipt.containerAddress]),
    };
    const replacements = receipt.rules.map((rule, index) => ({ ...rule, handle: 700 + index }));
    const recordedSecond = receipt.rules[1];
    const replacementFirst = replacements[0];
    if (recordedSecond === undefined || replacementFirst === undefined) throw new Error("Broken fixture.");
    expect(staleReceiptHandles(receipt, sameAddress, [...receipt.rules, ...replacements])).toEqual([
      622, 618,
    ]);
    expect(staleReceiptHandles(receipt, sameAddress, receipt.rules)).toEqual([]);
    expect(staleReceiptHandles(receipt, sameAddress, [recordedSecond, ...replacements])).toEqual([618]);
    expect(() =>
      staleReceiptHandles(receipt, sameAddress, [
        ...receipt.rules,
        ...replacements,
        { ...replacementFirst, handle: 999 },
      ]),
    ).toThrow();
  });
  test("fails closed for reused old address or changed receipt identity", () => {
    expect(() =>
      staleReceiptHandles(receipt, { ...current, liveAddresses: new Set(["10.89.3.8"]) }, rules),
    ).toThrow();
    expect(receiptMatchesOwner(receipt, { ...current, machineCreated: "replacement" })).toBe(false);
    expect(() => staleReceiptHandles(receipt, { ...current, containerId: "foreign" }, rules)).toThrow();
  });

  test("rejects corrupt persisted handle and port ranges", () => {
    const decode = Schema.decodeUnknownSync(PublishedContainerReceiptSchema);
    expect(() => decode({ ...receipt, rules: [{ ...receipt.rules[0], handle: 0 }] })).toThrow();
    expect(() => decode({ ...receipt, rules: [{ ...receipt.rules[0], hostPort: 70000 }] })).toThrow();
    expect(() => decode({ ...receipt, rules: [{ ...receipt.rules[0], containerPort: 1.5 }] })).toThrow();
  });
  test("never guesses when a receipt handle changed or a new publish is ambiguous", () => {
    const old = rules[0];
    const active = rules[2];
    if (old === undefined || active === undefined) throw new Error("Broken fixture.");
    expect(() =>
      staleReceiptHandles(receipt, current, [{ ...old, containerAddress: "10.89.3.9" }, ...rules.slice(1)]),
    ).toThrow();
    expect(() => currentPublishedRules(current, [...rules, { ...active, handle: 999 }])).toThrow();
  });
});
