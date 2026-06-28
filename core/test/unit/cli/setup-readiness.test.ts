import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
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
  test("read tolerates a summary file without runtimeService", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", steps));

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
        writeSetupReadiness(userDataRoot, "lando", steps, {
          running: true,
          socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
          pid: 1234,
          runtimeVersion: "5.0.0",
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
      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", steps, runtimeService));

      const caStep = {
        id: "ca",
        status: "satisfied" as const,
        evidence: "Certificate authority setup completed.",
      };
      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", [...steps, caStep]));

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
        writeSetupReadiness(userDataRoot, "lando", steps, {
          running: true,
          socketPath,
          pid: 1234,
          runtimeVersion: "5.0.0",
        }),
      );

      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", steps));

      const persisted = JSON.parse(await readFile(setupReadinessPath(userDataRoot), "utf-8"));
      expect(persisted.runtimeService.socketPath).toBe(socketPath);
    });
  });

  test("write with null runtimeService clears existing runtimeService block", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", steps, {
          running: true,
          socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
          pid: 1234,
          runtimeVersion: "5.0.0",
        }),
      );

      await Effect.runPromise(writeSetupReadiness(userDataRoot, "lando", steps, null));

      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));

      expect(summary?.runtimeService).toBeUndefined();
    });
  });

  test("read redacts runtimeService.socketPath", async () => {
    await withTempUserDataRoot(async (userDataRoot) => {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", steps, {
          running: true,
          socketPath:
            "/home/u/.local/share/lando/runtime/run/podman.sock?token=ABC123&X-Amz-Signature=deadbeef",
          pid: 1234,
          runtimeVersion: "5.0.0",
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
