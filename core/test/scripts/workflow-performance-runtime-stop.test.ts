import { expect, test } from "bun:test";
import { waitForPerformanceRuntimeStop } from "../../../scripts/workflow-performance-runtime-stop.ts";

test("rejects unconfirmed ownership without treating a teardown return as success", async () => {
  const terminate = async () => ({ terminated: false });
  await expect(
    waitForPerformanceRuntimeStop({ terminate, stopped: async () => true, timeoutMs: 0 }),
  ).rejects.toThrow("ownership/termination was not confirmed");
});

test("retains stores when a signalled runtime remains active at the deadline", async () => {
  const terminate = async () => ({ terminated: true, pid: 123 });
  await expect(
    waitForPerformanceRuntimeStop({ terminate, stopped: async () => false, timeoutMs: 0 }),
  ).rejects.toThrow("cleanup deadline");
});

test("accepts confirmed termination only when the owned runtime has stopped", async () => {
  const terminate = async () => ({ terminated: true, pid: 123 });
  await expect(
    waitForPerformanceRuntimeStop({ terminate, stopped: async () => true, timeoutMs: 0 }),
  ).resolves.toBeUndefined();
});
