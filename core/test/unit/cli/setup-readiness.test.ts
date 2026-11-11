import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  type SetupReadinessStep,
  readSetupReadiness,
  setupReadinessPath,
  writeSetupReadiness,
} from "../../../src/cli/commands/setup-readiness.ts";

const steps = [
  {
    id: "provider",
    status: "satisfied",
    evidence: "provider setup is satisfied",
  },
] satisfies ReadonlyArray<SetupReadinessStep>;

const withTempUserDataRoot = async <A>(run: (userDataRoot: string) => Promise<A>): Promise<A> => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-readiness-unit-"));
  try {
    return await run(userDataRoot);
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

describe("setup readiness persistence", () => {
  test.each([
    "{",
    "null",
    "{}",
    JSON.stringify({ status: "ready", providerId: 42, updatedAt: "now", steps: [] }),
    JSON.stringify({ status: "unknown", providerId: "lando", updatedAt: "now", steps: [] }),
    JSON.stringify({ status: "ready", providerId: "lando", updatedAt: "now", steps: [{}] }),
    JSON.stringify({
      status: "ready",
      providerId: "lando",
      updatedAt: "now",
      steps,
      runtimeService: { running: "true" },
    }),
    JSON.stringify({
      status: "ready",
      providerId: "lando",
      updatedAt: "now",
      steps: [{ id: "ca", status: "failed", evidence: "failed" }],
    }),
  ])("treats corrupt readiness as absent (%s)", async (contents) => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await mkdir(join(userDataRoot, "setup"));
      await writeFile(setupReadinessPath(userDataRoot), contents);
      expect(await Effect.runPromise(readSetupReadiness(userDataRoot))).toBeUndefined();
    });
  });

  // Records written before `in-progress` existed derived status from steps; they must still decode.
  test.each([
    { status: "ready", steps },
    {
      status: "deferred",
      steps: [...steps, { id: "file-sync", status: "deferred", evidence: "skipped", remediation: "rerun" }],
    },
    {
      status: "failed",
      steps: [...steps, { id: "ca", status: "unavailable", evidence: "missing", remediation: "rerun" }],
    },
  ])("decodes a record written before in-progress existed ($status)", async (record) => {
    await withTempUserDataRoot(async (userDataRoot) => {
      const persisted = {
        ...record,
        providerId: "lando",
        updatedAt: "2026-01-01T00:00:00.000Z",
        runtimeService: { running: true, socketPath: "/run/podman.sock", pid: 1 },
      };
      await mkdir(join(userDataRoot, "setup"));
      await writeFile(setupReadinessPath(userDataRoot), JSON.stringify(persisted));
      expect(await Effect.runPromise(readSetupReadiness(userDataRoot))).toEqual(persisted);
    });
  });

  test("treats a missing readiness file as absent", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      expect(await Effect.runPromise(readSetupReadiness(userDataRoot))).toBeUndefined();
    });
  });
  test("read tolerates a summary file without runtimeService", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", { status: "ready", steps }));

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toBeUndefined();
      expect(summary?.providerId).toBe("lando");
      expect(summary?.status).toBe("ready");
      expect(summary?.steps).toEqual(steps);
    });
  });

  test("write+read round-trips runtimeService", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", {
          status: "ready",
          steps,
          runtimeService: {
            running: true,
            socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
            pid: 1234,
            runtimeVersion: "5.0.0",
          },
        }),
      );

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toEqual({
        running: true,
        socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
        pid: 1234,
        runtimeVersion: "5.0.0",
      });
    });
  });

  test("write without runtimeService preserves existing runtimeService block", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      const runtimeService = {
        running: true,
        socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
        pid: 1234,
        runtimeVersion: "5.0.0",
      };
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", { status: "ready", steps, runtimeService }),
      );

      const caStep = {
        id: "ca",
        status: "satisfied" as const,
        evidence: "Certificate authority setup completed.",
      };
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", { status: "ready", steps: [...steps, caStep] }),
      );

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toEqual(runtimeService);
      expect(summary?.steps).toEqual([...steps, caStep]);
    });
  });

  test("write without runtimeService preserves the unredacted existing runtimeService block", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      const socketPath =
        "/home/u/.local/share/lando/runtime/run/podman.sock?token=ABC123&X-Amz-Signature=deadbeef";
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", {
          status: "ready",
          steps,
          runtimeService: {
            running: true,
            socketPath,
            pid: 1234,
            runtimeVersion: "5.0.0",
          },
        }),
      );

      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", { status: "ready", steps }));

      const persisted = JSON.parse(await readFile(setupReadinessPath(userDataRoot), "utf-8"));
      expect(persisted.runtimeService.socketPath).toBe(socketPath);
    });
  });

  test("write with null runtimeService clears existing runtimeService block", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", {
          status: "ready",
          steps,
          runtimeService: {
            running: true,
            socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
            pid: 1234,
            runtimeVersion: "5.0.0",
          },
        }),
      );

      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", { status: "ready", steps, runtimeService: null }),
      );

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toBeUndefined();
    });
  });

  test("read redacts runtimeService.socketPath", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", {
          status: "ready",
          steps,
          runtimeService: {
            running: true,
            socketPath:
              "/home/u/.local/share/lando/runtime/run/podman.sock?token=ABC123&X-Amz-Signature=deadbeef",
            pid: 1234,
            runtimeVersion: "5.0.0",
          },
        }),
      );

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toEqual({
        running: true,
        socketPath:
          "/home/u/.local/share/lando/runtime/run/podman.sock?token=[redacted]&X-Amz-Signature=[redacted]",
        pid: 1234,
        runtimeVersion: "5.0.0",
      });
    });
  });
});
