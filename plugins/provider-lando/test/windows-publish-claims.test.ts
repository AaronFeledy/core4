import { describe, expect, test } from "bun:test";

import { windowsPublishClaims } from "../src/windows-publish-claims.ts";

const match = (protocol: string, field: string, right: unknown) => ({
  match: { op: "==", left: { payload: { protocol, field } }, right },
});
const jump = (port: unknown, chain: string, address: string | undefined = "127.0.0.1") => ({
  rule: {
    family: "inet",
    table: "netavark",
    chain: "NETAVARK-HOSTPORT-DNAT",
    expr: [
      ...(address === undefined ? [] : [match("ip", "daddr", address)]),
      match("tcp", "dport", port),
      { jump: { target: chain } },
    ],
  },
});
const dnat = (port: unknown, address: string, chain: string, host = "127.0.0.1") => ({
  rule: {
    family: "inet",
    table: "netavark",
    chain,
    expr: [
      match("ip", "daddr", host),
      match("tcp", "dport", port),
      { dnat: { family: "ip", addr: address, port: 80 } },
    ],
  },
});
const rules = (...entries: unknown[]) => JSON.stringify({ nftables: [{ metainfo: {} }, ...entries] });

describe("Windows Netavark host-port claims", () => {
  test("detects stale and current DNAT targets in the same chain", () => {
    const claims = windowsPublishClaims(
      rules(jump(8888, "current"), dnat(8888, "10.89.1.5", "current"), dnat(8888, "10.89.1.2", "current")),
    );
    expect([...(claims.get(8888) ?? [])].sort()).toEqual(["10.89.1.2", "10.89.1.5"]);
  });

  test("detects an old network's claim before a current network", () => {
    const claims = windowsPublishClaims(
      rules(
        jump(8888, "old"),
        jump(8888, "current"),
        dnat(8888, "10.89.0.2", "old"),
        dnat(8888, "10.89.1.2", "current"),
      ),
    );
    expect([...(claims.get(8888) ?? [])].sort()).toEqual(["10.89.0.2", "10.89.1.2"]);
  });

  test("retains a clean single-owner claim", () => {
    const claims = windowsPublishClaims(rules(jump(18080, "current"), dnat(18080, "10.89.1.2", "current")));
    expect([...(claims.get(18080) ?? [])]).toEqual(["10.89.1.2"]);
  });

  test("ignores unrelated UDP and other-address claims but includes wildcard TCP", () => {
    const udp = {
      rule: {
        family: "inet",
        table: "netavark",
        chain: "udp",
        expr: [
          match("ip", "daddr", "127.0.0.1"),
          match("udp", "dport", 18080),
          { dnat: { family: "ip", addr: "10.89.1.8", port: 80 } },
        ],
      },
    };
    const claims = windowsPublishClaims(
      rules(
        udp,
        jump(8888, "other", "192.0.2.1"),
        dnat(8888, "10.89.1.8", "other", "192.0.2.1"),
        jump(18080, "wild", undefined),
        dnat(18080, "10.89.1.2", "wild", "0.0.0.0"),
      ),
    );
    expect(claims.has(8888)).toBe(false);
    expect([...(claims.get(18080) ?? [])]).toEqual(["10.89.1.2"]);
  });

  test("fails closed on malformed rules or unresolved jumps", () => {
    expect(() => windowsPublishClaims("{")).toThrow();
    expect(() => windowsPublishClaims(rules(jump("bad", "current")))).toThrow();
    expect([...(windowsPublishClaims(rules(jump(8888, "missing"))).get(8888) ?? [])]).toEqual([""]);
  });
});
