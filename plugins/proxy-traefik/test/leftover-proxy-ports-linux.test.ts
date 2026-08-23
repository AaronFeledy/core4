import { describe, expect, test } from "bun:test";

import type { ProcWalk } from "../src/leftover-proxy-ports-linux.ts";
import {
  commForSocketInode,
  commLooksLikeRootlessport,
  parseListenInodeForLoopbackPort,
} from "../src/leftover-proxy-ports-linux.ts";

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

describe("parseListenInodeForLoopbackPort", () => {
  test("reads the listen inode for a loopback IPv4 port", () => {
    // Given: /proc/net/tcp with 127.0.0.1:38080 listening (38080 = 0x94C0)
    const table = [
      TCP_HEADER,
      "   0: 0100007F:94C0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 424242 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    // When
    const inode = parseListenInodeForLoopbackPort(table, 38080);

    // Then
    expect(inode).toBe("424242");
  });

  test("ignores established rows and non-loopback listeners", () => {
    // Given: established 38080 plus a 0.0.0.0 listener
    const table = [
      TCP_HEADER,
      "   0: 0100007F:94C0 0100007F:1234 01 00000000:00000000 00:00000000 00000000     0        0 111 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:94C0 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0",
    ].join("\n");

    // When / Then
    expect(parseListenInodeForLoopbackPort(table, 38080)).toBeUndefined();
  });
});

describe("commLooksLikeRootlessport", () => {
  test("matches full and truncated comm names", () => {
    expect(commLooksLikeRootlessport("rootlessport")).toBe(true);
    expect(commLooksLikeRootlessport("rootlessp")).toBe(true);
    expect(commLooksLikeRootlessport("nginx")).toBe(false);
  });
});

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

describe("commForSocketInode", () => {
  test("walks fds only for rootlessport-shaped comms", async () => {
    // Given: hundreds of foreign pids plus one leftover holder
    const files: Record<string, string | ReadonlyArray<string>> = {
      "/proc": ["1", "self", "2"],
      "/proc/1/comm": "systemd",
      "/proc/2/comm": "rootlessport",
      "/proc/2/fd": ["0", "3"],
      "/proc/2/fd/0": "pipe:[1]",
      "/proc/2/fd/3": "socket:[424242]",
    };
    let fdWalks = 0;
    const walk = walkFrom(files);
    const counted: ProcWalk = {
      ...walk,
      names: async (path) => {
        if (path.endsWith("/fd")) fdWalks += 1;
        return walk.names(path);
      },
    };

    // When
    const comm = await commForSocketInode("424242", counted);

    // Then: holder identified without opening systemd fds
    expect(comm).toBe("rootlessport");
    expect(fdWalks).toBe(1);
  });

  test("returns undefined once the comm-scan budget elapses", async () => {
    // Given: a clock that is already past the deadline after listing /proc
    let now = 0;
    const walk: ProcWalk = {
      now: () => now,
      names: async (path) => {
        if (path === "/proc") {
          now = 2;
          return ["2"];
        }
        return ["3"];
      },
      text: async () => "rootlessport",
      link: async () => "socket:[424242]",
    };

    // When
    const comm = await commForSocketInode("424242", walk, 1);

    // Then: no leftover comm after the budget
    expect(comm).toBeUndefined();
  });
});
