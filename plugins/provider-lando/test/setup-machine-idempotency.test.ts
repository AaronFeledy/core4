import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ensureMacOSPodmanMachine, ensureWindowsPodmanMachine } from "@lando/provider-lando";
import type { PodmanMachineRunner, PodmanMachineStatus } from "../src/setup.ts";

const runner = (status: PodmanMachineStatus, calls: string[]): PodmanMachineRunner => ({
  inspect: Effect.sync(() => {
    calls.push("inspect");
    return status;
  }),
  create: Effect.sync(() => calls.push("create")).pipe(Effect.asVoid),
  syncTrust: Effect.sync(() => calls.push("syncTrust")).pipe(Effect.asVoid),
  start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
  stop: Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
  upgrade: Effect.void,
  teardown: Effect.void,
});

describe("owned Podman machine setup idempotency", () => {
  for (const [platform, ensureMachine] of [
    ["macOS", ensureMacOSPodmanMachine],
    ["Windows", ensureWindowsPodmanMachine],
  ] as const) {
    test(`${platform} leaves a running owned machine untouched`, async () => {
      const calls: string[] = [];
      await Effect.runPromise(
        ensureMachine(runner("running", calls), { name: "lando", createdByLando: true }),
      );
      expect(calls).toEqual(["inspect"]);
    });

    test(`${platform} syncs trust before starting a stopped owned machine`, async () => {
      const calls: string[] = [];
      await Effect.runPromise(
        ensureMachine(runner("stopped", calls), { name: "lando", createdByLando: true }),
      );
      expect(calls).toEqual(["inspect", "syncTrust", "start"]);
    });
  }
});
