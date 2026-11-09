import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { readManagedProcesses } from "../src/podman/managed-status-io.ts";
import {
  type ManagedProcess,
  type ManagedProcessIdentity,
  classifyManagedRuntime,
  descendsFrom,
  managedProcessPids,
} from "../src/podman/managed-status.ts";
import { parseRuntimeShutdownReceipt } from "../src/podman/runtime-shutdown.ts";

const identity: ManagedProcessIdentity = {
  socketPath: "/runtime/run/podman.sock",
  runtimeBinDirs: ["/runtime/bin", "/real/runtime/bin"],
  recordedPid: 1500,
};
const service: ManagedProcess = {
  pid: 1500,
  parentPid: 1,
  argv: ["/runtime/bin/podman", "system", "service", "--time=0", "unix:///runtime/run/podman.sock"],
};
const process = (fields: Partial<ManagedProcess>): ManagedProcess => ({
  pid: 12,
  parentPid: 1,
  argv: [],
  ...fields,
});

test.each([
  { state: "stopped", boot: "current", idle: true },
  { state: "admitted", boot: "current", idle: false },
  { state: "stopped", boot: "previous", idle: true },
  { state: "admitted", boot: "previous", idle: true },
] as const)("$state receipt from $boot boot supplies idle=$idle", ({ state, boot, idle }) => {
  const receipt = parseRuntimeShutdownReceipt(
    JSON.stringify({
      version: 1,
      data: { generation: "admission", bootId: boot, state },
    }),
  );
  const result = classifyManagedRuntime({
    state: "silent",
    bundleInstalled: true,
    livePids: [],
    receipt,
    bootId: "current",
  });
  expect(result).toMatchObject(idle ? { state: "idle" } : { _tag: "ProviderUnavailableError" });
});

test.each([
  "{",
  "{}",
  '{"version":2,"data":{"generation":"g","bootId":"old","state":"stopped"}}',
  '{"version":1,"data":{"bootId":"old","state":"stopped"}}',
])("invalid receipt supplies no idle evidence: %s", (raw) => {
  const receipt = parseRuntimeShutdownReceipt(raw);
  expect(receipt).toBeUndefined();
  expect(
    classifyManagedRuntime({
      state: "silent",
      bundleInstalled: true,
      livePids: [],
      receipt,
      bootId: "current",
    }),
  ).toMatchObject({ _tag: "ProviderUnavailableError" });
});

test.each([
  {
    name: "unreadable boot",
    bundleInstalled: true,
    livePids: [],
    bootId: undefined,
    message: "Runtime state is unknown",
  },
  { name: "live process", bundleInstalled: true, livePids: [42], bootId: "boot", message: "alive" },
  { name: "missing bundle", bundleInstalled: false, livePids: [], bootId: "boot", message: "not installed" },
])("stopped receipt cannot hide $name", ({ bundleInstalled, livePids, bootId, message }) => {
  const result = classifyManagedRuntime({
    state: "silent",
    bundleInstalled,
    livePids,
    bootId,
    receipt: { generation: "g", state: "stopped", bootId: "boot" },
  });
  expect(result).toBeInstanceOf(ProviderUnavailableError);
  expect(result.message).toContain(message);
});

test.each([
  { name: "service", processes: [service], pids: [1500] },
  {
    name: "rootless child",
    processes: [service, process({ pid: 1512, parentPid: 1500, argv: ["podman-child"] })],
    pids: [1500, 1512],
  },
  { name: "pause", processes: [process({ argv: ["/runtime/bin/podman"] })], pids: [12] },
  { name: "conmon", processes: [process({ argv: ["/runtime/bin/conmon", "-c", "abc"] })], pids: [12] },
  {
    name: "network helper under the canonical bin path",
    processes: [process({ argv: ["/real/runtime/bin/pasta", "--config-net"] })],
    pids: [12],
  },
])("a live managed $name prevents idle", ({ processes, pids }) => {
  const livePids = managedProcessPids(processes, identity);
  expect(livePids).toEqual(pids);
  const status = classifyManagedRuntime({ state: "silent", bundleInstalled: true, livePids });
  expect(status).toBeInstanceOf(ProviderUnavailableError);
  expect(status).toMatchObject({ operation: "getStatus", details: { pids } });
});

test("processes outside this data root's runtime are not managed", () => {
  const processes = [
    process({ pid: 20, argv: ["/usr/lib/systemd/systemd", "--user"] }),
    process({ pid: 21, argv: ["/other-root/runtime/bin/podman", "system", "service"] }),
    process({ pid: 22, argv: ["/runtime/binaries/podman"] }),
    process({ pid: 23, argv: ["podman", "ps"] }),
  ];
  expect(managedProcessPids(processes, identity)).toEqual([]);
});

test.each([
  { name: "rewritten argv", processes: [process({ argv: ["workload"] })] },
  { name: "empty argv", processes: [process({ argv: [] })] },
  { name: "host catatonit pause", processes: [process({ argv: ["/usr/bin/catatonit", "-P"] })] },
  { name: "foreign PID namespace or admission after the PID snapshot", processes: [] },
])("silent runtime stays unknown with $name", ({ processes }) => {
  const livePids = managedProcessPids(processes, identity);
  expect(livePids).toEqual([]);
  expect(classifyManagedRuntime({ state: "silent", bundleInstalled: true, livePids })).toMatchObject({
    _tag: "ProviderUnavailableError",
    operation: "getStatus",
  });
});

test("answering, missing bundle, and unreadable evidence retain their diagnoses", () => {
  expect(classifyManagedRuntime({ state: "answering" })).toMatchObject({ state: "running" });
  expect(classifyManagedRuntime({ state: "silent", bundleInstalled: false, livePids: [] })).toMatchObject({
    _tag: "ProviderUnavailableError",
    remediation: "Run `lando setup` to install the managed runtime.",
  });
  expect(classifyManagedRuntime({ state: "unreadable" })).toMatchObject({ _tag: "ProviderUnavailableError" });
});

let procRoot: string | undefined;
afterEach(async () => {
  if (procRoot !== undefined) await rm(procRoot, { recursive: true, force: true });
  procRoot = undefined;
});

const writeProc = async (
  root: string,
  pid: number,
  fields: { argv: string[]; uid: number; ppid: number },
) => {
  const dir = join(root, String(pid));
  await mkdir(dir);
  await writeFile(
    join(dir, "status"),
    `Name:\tx\nState:\tS (sleeping)\nPPid:\t${fields.ppid}\nUid:\t${fields.uid}\t${fields.uid}\t${fields.uid}\t${fields.uid}\n`,
  );
  await writeFile(join(dir, "cmdline"), `${fields.argv.join("\0")}\0`);
  // Non-dumpable processes (systemd --user, ssh-agent) hide their environment from their owner.
  await writeFile(join(dir, "environ"), "");
  await chmod(join(dir, "environ"), 0o000);
};

test("the user's non-dumpable processes do not hide the process inventory", async () => {
  const uid = globalThis.process.getuid?.() ?? 1000;
  procRoot = await mkdtemp(join(tmpdir(), "lando-proc-"));
  await writeProc(procRoot, 980, { argv: ["/usr/lib/systemd/systemd", "--user"], uid, ppid: 1 });
  await writeProc(procRoot, 4213, { argv: ["/runtime/bin/podman"], uid, ppid: 1 });
  await writeProc(procRoot, 4400, { argv: ["/runtime/bin/podman"], uid: uid + 1, ppid: 1 });
  const processes = await readManagedProcesses(procRoot);
  expect(processes.map(({ pid }) => pid).toSorted()).toEqual([4213, 980]);
  expect(managedProcessPids(processes, identity)).toEqual([4213]);
});

test("unreadable proc does not become an empty process inventory", async () => {
  await expect(readManagedProcesses("/no-such-lando-proc")).rejects.toMatchObject({ code: "ENOENT" });
});

test("ancestry includes the rootless service child and refuses incomplete evidence", () => {
  expect(
    descendsFrom(
      [
        { pid: 1500, parentPid: 1 },
        { pid: 1512, parentPid: 1500 },
      ],
      1512,
      1500,
    ),
  ).toBe(true);
  expect(descendsFrom([{ pid: 1512, parentPid: 999 }], 1512, 1500)).toBeUndefined();
  expect(descendsFrom([{ pid: 1512, parentPid: 1 }], 1512, 1500)).toBe(false);
});
