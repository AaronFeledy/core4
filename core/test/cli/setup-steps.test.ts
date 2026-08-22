import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { FileSyncEngine } from "@lando/core/services";
import { TestFileSyncEngine } from "@lando/sdk/test";

import {
  type SetupReadinessRecorder,
  makeSetupReadinessRecorder,
  runFileSyncSetupStep,
  setupDeferredFileSyncPath,
} from "../../src/cli/command-specs/meta/setup-steps.ts";
import type { ResolvedSetupNetworkTrust } from "../../src/cli/commands/setup-network-trust.ts";
import type { SetupReadinessStep } from "../../src/cli/commands/setup-readiness.ts";

const network = {
  proxy: { noProxy: [], injectIntoServices: false },
  ca: { trustHost: true, certs: [], loadedCerts: [], injectIntoServices: true },
} satisfies ResolvedSetupNetworkTrust;

const slowProvider = { capabilities: { bindMountPerformance: "slow" } } as const;
const nativeProvider = { capabilities: { bindMountPerformance: "native" } } as const;

const makeRecorder = () => {
  const steps: SetupReadinessStep[] = [];
  const record = (step: SetupReadinessStep) =>
    Effect.sync(() => {
      steps.push(step);
    });
  const recorder: SetupReadinessRecorder = {
    record,
    recordFailure: (id, cause) =>
      record({ id, status: "failed", evidence: String(cause), remediation: "retry" }),
    recordUnavailable: (id, serviceName) =>
      record({
        id,
        status: "unavailable",
        evidence: `${serviceName} setup service is not available.`,
        remediation: "install an engine",
      }),
    setRuntimeService: () => undefined,
  };
  return { recorder, steps };
};

describe("file-sync setup step", () => {
  test("returns installed and calls setup when an engine service is present", async () => {
    const calls: string[] = [];
    const { recorder, steps } = makeRecorder();
    const fileSync = {
      ...TestFileSyncEngine,
      setup: () =>
        Effect.sync(() => {
          calls.push("setup");
        }),
    };

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: slowProvider,
        input: {},
        userDataRoot: "/tmp/lando-test",
        network,
        recorder,
      }).pipe(Effect.provide(Layer.succeed(FileSyncEngine, fileSync))),
    );

    expect(status).toBe("installed");
    expect(calls).toEqual(["setup"]);
    expect(steps.map((step) => step.status)).toEqual(["installed"]);
  });

  test("returns unavailable when no engine service can be resolved", async () => {
    const { recorder, steps } = makeRecorder();

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: slowProvider,
        input: {},
        userDataRoot: "/tmp/lando-test",
        network,
        recorder,
      }),
    );

    expect(status).toBe("unavailable");
    expect(steps.map((step) => step.status)).toEqual(["unavailable"]);
  });

  test("returns deferred and records the bundled engine id when setup is skipped", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-step-deferred-"));
    const { recorder, steps } = makeRecorder();
    try {
      const status = await Effect.runPromise(
        runFileSyncSetupStep({
          provider: slowProvider,
          input: { flags: { "skip-file-sync": true } },
          userDataRoot,
          network,
          recorder,
        }),
      );
      const marker: unknown = JSON.parse(await readFile(setupDeferredFileSyncPath(userDataRoot), "utf-8"));

      expect(status).toBe("deferred");
      expect(marker).toEqual({ status: "deferred", engineId: "mutagen", resumeCommand: "lando start" });
      expect(steps.map((step) => step.status)).toEqual(["deferred"]);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("returns satisfied without resolving an engine for native bind mounts", async () => {
    const { recorder, steps } = makeRecorder();

    const status = await Effect.runPromise(
      runFileSyncSetupStep({
        provider: nativeProvider,
        input: {},
        userDataRoot: undefined,
        network,
        recorder,
      }),
    );

    expect(status).toBe("satisfied");
    expect(steps.map((step) => step.status)).toEqual(["satisfied"]);
  });
});

describe("setup readiness recorder", () => {
  test("firstFailedStep returns the first failed record and ignores later failures", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-first-failed-"));
    try {
      const recorder = makeSetupReadinessRecorder(userDataRoot, "lando");
      expect(recorder.firstFailedStep()).toBeUndefined();
      await Effect.runPromise(recorder.record({ id: "provider", status: "satisfied", evidence: "ok" }));
      expect(recorder.firstFailedStep()).toBeUndefined();
      await Effect.runPromise(recorder.recordFailure("ca", new Error("ca boom")));
      await Effect.runPromise(recorder.recordFailure("proxy", new Error("proxy boom")));
      const first = recorder.firstFailedStep();
      expect(first?.id).toBe("ca");
      expect(first?.status).toBe("failed");
      expect(first?.evidence).toContain("ca boom");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
