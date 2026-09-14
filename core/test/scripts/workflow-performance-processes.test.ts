import { expect, test } from "bun:test";
import {
  isPerformanceRuntimeHelper,
  signalPerformanceProcess,
} from "../../../scripts/workflow-performance-processes.ts";

const root = "/private/sample/data";
const pause = {
  pid: 123,
  uid: 1000,
  startTime: "456",
  executable: `${root}/runtime/bin/podman`,
  argv: [`${root}/runtime/bin/podman`],
};

test("recognizes an orphaned exec monitor only for its private container bundle", () => {
  const monitor = {
    ...pause,
    executable: `${root}/runtime/bin/conmon`,
    argv: ["conmon", "-b", `${root}/runtime/storage/overlay-containers/id/userdata/exec`, "-e"],
  };
  expect(isPerformanceRuntimeHelper(monitor, root)).toBe(true);
  expect(
    isPerformanceRuntimeHelper({ ...monitor, argv: ["conmon", "-b", "/shared/bundle", "--exec"] }, root),
  ).toBe(false);
  expect(isPerformanceRuntimeHelper({ ...monitor, argv: monitor.argv.slice(0, -1) }, root)).toBe(false);
});

test("recognizes the private namespace holder when the API service has exited", () => {
  // Given a private Podman pause process without service arguments.
  // When ownership is classified, then it is a cleanup helper.
  expect(isPerformanceRuntimeHelper(pause, root)).toBe(true);
});

test.each(["/shared", `${root}-other`])("rejects a helper using another root %s", (other) => {
  // Given a shared or similarly prefixed executable.
  const process = { ...pause, executable: `${other}/runtime/bin/podman` };
  // When classified, then it must not be signalled.
  expect(isPerformanceRuntimeHelper(process, root)).toBe(false);
});

test.each([{ startTime: "999" }, { uid: 2000 }, { executable: "/shared/podman" }])(
  "refuses a stale process identity when %j changes",
  async (change) => {
    // Given a captured identity whose PID has since changed ownership.
    const signals: number[] = [];
    // When cleanup rechecks immediately before signalling.
    await signalPerformanceProcess(
      pause,
      async () => ({ ...pause, ...change }),
      (pid) => signals.push(pid),
    );
    // Then no signal reaches the replacement process.
    expect(signals).toEqual([]);
  },
);

test("signals the captured process when its identity still matches", async () => {
  // Given a live owned helper.
  const signals: number[] = [];
  // When its identity is rechecked.
  await signalPerformanceProcess(
    pause,
    async () => pause,
    (pid) => signals.push(pid),
  );
  // Then only that PID receives a signal.
  expect(signals).toEqual([123]);
});
