import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeIptablesForwardCheck } from "../src/iptables-forward-check.ts";

describe("iptables FORWARD check", () => {
  test("returns no reports on non-Linux platforms", async () => {
    const check = makeIptablesForwardCheck();
    const darwinResult = await Effect.runPromise(check.run({ platform: "darwin" }));
    const win32Result = await Effect.runPromise(check.run({ platform: "win32" }));
    const wslResult = await Effect.runPromise(check.run({ platform: "wsl" }));

    expect(darwinResult).toEqual([]);
    expect(win32Result).toEqual([]);
    expect(wslResult).toEqual([]);
  });

  test("returns no reports when iptables-legacy has ACCEPT policy", async () => {
    const mockReaders = {
      readIptablesLegacyForward: async () =>
        "Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)\n target     prot opt source               destination",
      readIptablesNftForward: async () => "Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)",
    };

    const check = makeIptablesForwardCheck(mockReaders);
    const result = await Effect.runPromise(check.run({ platform: "linux" }));

    expect(result).toEqual([]);
  });

  test("returns no reports when iptables-legacy has DROP but also has lando rules", async () => {
    const mockReaders = {
      readIptablesLegacyForward: async () =>
        "Chain FORWARD (policy DROP 0 packets, 0 bytes)\n ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            /* lando */",
      readIptablesNftForward: async () =>
        "Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)\n ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            /* lando */",
    };

    const check = makeIptablesForwardCheck(mockReaders);
    const result = await Effect.runPromise(check.run({ platform: "linux" }));

    expect(result).toEqual([]);
  });

  test("returns warning when iptables-legacy has DROP policy and no lando rules but nft does", async () => {
    const mockReaders = {
      readIptablesLegacyForward: async () =>
        "Chain FORWARD (policy DROP 0 packets, 0 bytes)\n target     prot opt source               destination",
      readIptablesNftForward: async () =>
        "Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)\n ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            /* lando-global */",
    };

    const check = makeIptablesForwardCheck(mockReaders);
    const result = await Effect.runPromise(check.run({ platform: "linux" }));

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("docker-iptables-forward-mixed");
    expect(result[0]?.status).toBe("warn");
    expect(result[0]?.solutions).toHaveLength(2);
    expect(result[0]?.solutions[0]?.command).toBe("sudo iptables-legacy -P FORWARD ACCEPT");
  });

  test("returns no reports when both legacy and nft have no lando rules", async () => {
    const mockReaders = {
      readIptablesLegacyForward: async () =>
        "Chain FORWARD (policy DROP 0 packets, 0 bytes)\n target     prot opt source               destination",
      readIptablesNftForward: async () =>
        "Chain FORWARD (policy ACCEPT 0 packets, 0 bytes)\n target     prot opt source               destination",
    };

    const check = makeIptablesForwardCheck(mockReaders);
    const result = await Effect.runPromise(check.run({ platform: "linux" }));

    expect(result).toEqual([]);
  });

  test("returns no reports when iptables commands are not available", async () => {
    const mockReaders = {
      readIptablesLegacyForward: async () => undefined,
      readIptablesNftForward: async () => undefined,
    };

    const check = makeIptablesForwardCheck(mockReaders);
    const result = await Effect.runPromise(check.run({ platform: "linux" }));

    expect(result).toEqual([]);
  });
});
