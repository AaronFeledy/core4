import { expect, test } from "bun:test";
import {
  environTouchesPerformanceRoot,
  isPerformanceRuntimeHelper,
  signalPerformanceProcess,
  stopPerformanceHelpers,
} from "../../../scripts/workflow-performance-processes.ts";

const root = "/private/sample/data";
const pause = {
  pid: 123,
  uid: 1000,
  startTime: "456",
  executable: `${root}/runtime/bin/podman`,
  argv: [`${root}/runtime/bin/podman`],
};

test("recognizes bundled runtime binaries as owned helpers", () => {
  const monitor = {
    ...pause,
    executable: `${root}/runtime/bin/conmon`,
    argv: ["conmon", "-b", "/shared/bundle", "--exec"],
  };
  const rootlessport = {
    ...pause,
    executable: `${root}/runtime/bin/rootlessport`,
    argv: [`${root}/runtime/bin/rootlessport`],
  };
  expect(isPerformanceRuntimeHelper(monitor, root)).toBe(true);
  expect(isPerformanceRuntimeHelper(rootlessport, root)).toBe(true);
});

test("recognizes a detached host-proxy worker only when its environ names the private root", () => {
  const worker = {
    ...pause,
    executable: "/opt/lando/dist/lando",
    argv: ["/opt/lando/dist/lando", "__internal:host-proxy-worker", "--app-id", "perf-1"],
  };
  expect(isPerformanceRuntimeHelper(worker, root)).toBe(false);
  expect(isPerformanceRuntimeHelper(worker, root, `LANDO_USER_DATA_ROOT=${root}\0`)).toBe(true);
  expect(isPerformanceRuntimeHelper(worker, root, "LANDO_USER_DATA_ROOT=/other\0")).toBe(false);
});

test("matches only the exact private data and runtime root environ entries", () => {
  expect(environTouchesPerformanceRoot(`LANDO_USER_DATA_ROOT=${root}\0`, root)).toBe(true);
  expect(environTouchesPerformanceRoot(`LANDO_USER_DATA_ROOT=${root}-other\0`, root)).toBe(false);
});

test("recognizes the private namespace holder when the API service has exited", () => {
  expect(isPerformanceRuntimeHelper(pause, root)).toBe(true);
});

test.each(["/shared", `${root}-other`])("rejects a helper using another root %s", (other) => {
  const process = { ...pause, executable: `${other}/runtime/bin/podman` };
  expect(isPerformanceRuntimeHelper(process, root)).toBe(false);
});

test.each([{ startTime: "999" }, { uid: 2000 }, { executable: "/shared/podman" }])(
  "refuses a stale process identity when %j changes",
  async (change) => {
    const signals: number[] = [];
    await signalPerformanceProcess(
      pause,
      async () => ({ ...pause, ...change }),
      (pid) => signals.push(pid),
    );
    expect(signals).toEqual([]);
  },
);

test("signals the captured process when its identity still matches", async () => {
  const signals: number[] = [];
  await signalPerformanceProcess(
    pause,
    async () => pause,
    (pid) => signals.push(pid),
  );
  expect(signals).toEqual([123]);
});

test("continues helper scans when a process executable is unreadable", async () => {
  await expect(stopPerformanceHelpers("/no-such-performance-root")).resolves.toBeUndefined();
});
