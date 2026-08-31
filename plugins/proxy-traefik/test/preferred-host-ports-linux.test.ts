import { describe, expect, test } from "bun:test";

import type { ProcWalk } from "../src/leftover-proxy-ports-linux.ts";
import { identifyAnyPortHolder, parseListenInodeForPort } from "../src/preferred-host-ports-linux.ts";

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

const walkFrom = (files: Readonly<Record<string, string | ReadonlyArray<string>>>): ProcWalk => ({
  names: async (path) => {
    const value = files[path];
    return Array.isArray(value) ? value : undefined;
  },
  text: async (path) => {
    const value = files[path];
    return typeof value === "string" ? value : undefined;
  },
  link: async (path) => {
    const value = files[path];
    return typeof value === "string" ? value : undefined;
  },
});

describe("parseListenInodeForPort", () => {
  test("reads the listen inode for 0.0.0.0:80", () => {
    // Contrast: leftover parseListenInodeForLoopbackPort ignores 0.0.0.0; this parser does not.
    // Given: /proc/net/tcp with 00000000:0050 LISTEN (0.0.0.0:80, 80 = 0x0050)
    const table = [
      TCP_HEADER,
      "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 808080 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    // When
    const inode = parseListenInodeForPort(table, 80);

    // Then
    expect(inode).toBe("808080");
  });

  test("reads the listen inode for loopback 127.0.0.1:80", () => {
    // Given: /proc/net/tcp with 0100007F:0050 LISTEN (127.0.0.1:80)
    const table = [
      TCP_HEADER,
      "   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 127080 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    // When
    const inode = parseListenInodeForPort(table, 80);

    // Then
    expect(inode).toBe("127080");
  });

  test("ignores established rows", () => {
    // Given: established 0.0.0.0:80 (state 01) and no LISTEN row
    const table = [
      TCP_HEADER,
      "   0: 00000000:0050 0100007F:1234 01 00000000:00000000 00:00000000 00000000     0        0 111 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    // When / Then
    expect(parseListenInodeForPort(table, 80)).toBeUndefined();
  });
});

describe("identifyAnyPortHolder", () => {
  test("identifies nginx without skipping non-rootlessport comms", async () => {
    // Given: systemd plus nginx holding 0.0.0.0:80; occupancy walks every numeric pid
    const tcp = [
      TCP_HEADER,
      "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 808080 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    const walk = walkFrom({
      "/proc/net/tcp": tcp,
      "/proc": ["1", "self", "42"],
      "/proc/1/comm": "systemd",
      "/proc/1/fd": ["0"],
      "/proc/1/fd/0": "pipe:[1]",
      "/proc/42/comm": "nginx",
      "/proc/42/fd": ["0", "3"],
      "/proc/42/fd/0": "pipe:[2]",
      "/proc/42/fd/3": "socket:[808080]",
    });

    // When
    const holder = await identifyAnyPortHolder(80, walk);

    // Then
    expect(holder).toEqual({ comm: "nginx", pid: 42 });
  });

  test("includes cmdline when present", async () => {
    // Given: nginx with a null-separated cmdline
    const tcp = [
      TCP_HEADER,
      "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 808080 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    const walk = walkFrom({
      "/proc/net/tcp": tcp,
      "/proc": ["42"],
      "/proc/42/comm": "nginx\n",
      "/proc/42/cmdline": "nginx\0-g\0daemon off;\0",
      "/proc/42/fd": ["3"],
      "/proc/42/fd/3": "socket:[808080]",
    });

    // When
    const holder = await identifyAnyPortHolder(80, walk);

    // Then
    expect(holder).toEqual({ comm: "nginx", pid: 42, cmdline: "nginx -g daemon off; " });
  });

  test("returns undefined once the scan budget elapses", async () => {
    // Given: a clock that is already past the deadline after listing /proc
    let now = 0;
    const walk: ProcWalk = {
      now: () => now,
      names: async (path) => {
        if (path === "/proc") {
          now = 2;
          return ["42"];
        }
        return ["3"];
      },
      text: async (path) => {
        if (path === "/proc/net/tcp") {
          return [
            TCP_HEADER,
            "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 808080 1 0000000000000000 100 0 0 10 0",
          ].join("\n");
        }
        return "nginx";
      },
      link: async () => "socket:[808080]",
    };

    // When
    const holder = await identifyAnyPortHolder(80, walk, 1);

    // Then
    expect(holder).toBeUndefined();
  });
});
