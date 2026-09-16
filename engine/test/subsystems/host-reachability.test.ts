import { describe, expect, it } from "bun:test";

import {
  HOST_GATEWAY_TARGET,
  HOST_INTERNAL_ALIAS,
  HOST_IP_ENV_KEY,
  applyHostReachability,
} from "../../src/subsystems/networking.ts";

const plan = (
  overrides: Partial<{
    environment: Record<string, string>;
    hostAliases: Array<{ hostname: string; ip: string }>;
  }> = {},
) => ({
  environment: {},
  hostAliases: [],
  ...overrides,
});

describe("applyHostReachability", () => {
  it("Given a provider that natively reaches the host, When applied, Then the alias and variable are realized", () => {
    const result = applyHostReachability(plan(), "native");
    expect(result.hostAliases).toEqual([{ hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET }]);
    expect(result.environment[HOST_IP_ENV_KEY]).toBe(HOST_INTERNAL_ALIAS);
  });

  it("Given an emulated host gateway, When applied, Then the same alias is realized", () => {
    const result = applyHostReachability(plan(), "emulated");
    expect(result.hostAliases).toEqual([{ hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET }]);
  });

  it("Given a provider that cannot reach the host, When applied, Then no alias and no variable exist", () => {
    const result = applyHostReachability(plan(), "none");
    expect(result.hostAliases).toEqual([]);
    expect(HOST_IP_ENV_KEY in result.environment).toBe(false);
  });

  it("Given an unreachable host, When applied, Then a stale host variable is removed rather than kept", () => {
    const result = applyHostReachability(
      plan({ environment: { [HOST_IP_ENV_KEY]: "10.0.0.1", LANDO: "ON" } }),
      "none",
    );
    expect(result.environment).toEqual({ LANDO: "ON" });
  });

  it("Given other aliases already planned, When applied, Then they survive and only the host alias is replaced", () => {
    const result = applyHostReachability(
      plan({
        hostAliases: [
          { hostname: "legacy.internal", ip: "127.0.0.1" },
          { hostname: HOST_INTERNAL_ALIAS, ip: "192.168.0.1" },
        ],
      }),
      "emulated",
    );
    expect(result.hostAliases).toEqual([
      { hostname: "legacy.internal", ip: "127.0.0.1" },
      { hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET },
    ]);
  });

  it("Given no capability, When applied, Then a previously planned host alias is dropped", () => {
    const result = applyHostReachability(
      plan({ hostAliases: [{ hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET }] }),
      "none",
    );
    expect(result.hostAliases).toEqual([]);
  });
});
