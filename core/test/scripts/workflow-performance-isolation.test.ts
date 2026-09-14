import { expect, test } from "bun:test";
import {
  inspectOwnedPerformanceResources,
  parseListenEntries,
  processTouchesPerformanceRoot,
} from "../../../scripts/workflow-performance-isolation.ts";
import type { IsolationWalk } from "../../../scripts/workflow-performance-isolation.ts";
import { isPerformanceRuntimeHelper } from "../../../scripts/workflow-performance-processes.ts";

const root = "/private/sample/data";
const rootlessport = {
  pid: 4242,
  uid: 1000,
  startTime: "99",
  executable: `${root}/runtime/bin/rootlessport`,
  argv: [`${root}/runtime/bin/rootlessport`],
};

test("classifies an owned rootlessport as touching the private data root", () => {
  expect(processTouchesPerformanceRoot(rootlessport, root)).toBe(true);
  expect(processTouchesPerformanceRoot(rootlessport, `${root}-other`)).toBe(false);
});

test("cleanup helper scan currently omits owned rootlessport host-port holders", () => {
  expect(isPerformanceRuntimeHelper(rootlessport, root)).toBe(false);
});

test("parses a loopback listen inode for port 80", () => {
  const table =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0\n";
  expect(parseListenEntries(table)).toEqual([{ port: 80, inode: "12345" }]);
});

test("inspect reports leftover host listen ports owned by private-root processes", async () => {
  const walk: IsolationWalk = {
    uid: 1000,
    roots: [root],
    pids: async () => [4242],
    process: async () => rootlessport,
    fds: async () => ["3"],
    fdTarget: async () => "socket:[12345]",
    tcpTables: async () => [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0\n",
    ],
    netnsTcpTables: async () => [],
    socketNames: async () => ["podman.sock"],
  };
  const snapshot = await inspectOwnedPerformanceResources(walk);
  expect(snapshot.processes).toEqual([rootlessport]);
  expect(snapshot.listen).toEqual([{ port: 80, pid: 4242, comm: `${root}/runtime/bin/rootlessport` }]);
  expect(snapshot.sockets).toEqual(["podman.sock"]);
});
