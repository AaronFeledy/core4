import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { detectProviderConflicts } from "../../src/providers/conflict.ts";

let workDir: string;

const writeProviderLandoState = async (stateDir: string, socketPath: string): Promise<string> => {
  const path = join(stateDir, "provider-lando");
  await mkdir(path, { recursive: true });
  const statePath = join(path, "setup-state.json");
  await writeFile(statePath, JSON.stringify({ socketPath }), "utf8");
  return statePath;
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "lando-conflict-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("detectProviderConflicts", () => {
  test("returns empty when stateDir is undefined", async () => {
    const conflicts = await Effect.runPromise(detectProviderConflicts({ stateDir: undefined }));
    expect(conflicts).toEqual([]);
  });

  test("returns empty when no provider-lando setup state file exists", async () => {
    const conflicts = await Effect.runPromise(
      detectProviderConflicts({
        stateDir: workDir,
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    );
    expect(conflicts).toEqual([]);
  });

  test("returns empty when recorded socket does not match resolved Podman socket", async () => {
    await writeProviderLandoState(workDir, "/var/run/lando/podman.sock");
    const conflicts = await Effect.runPromise(
      detectProviderConflicts({
        stateDir: workDir,
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    );
    expect(conflicts).toEqual([]);
  });

  test("reports lando-podman-socket conflict with remediation when sockets match", async () => {
    const statePath = await writeProviderLandoState(workDir, "/run/user/1000/podman/podman.sock");
    const conflicts = await Effect.runPromise(
      detectProviderConflicts({
        stateDir: workDir,
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    );

    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict?._tag).toBe("ProviderLandoConflict");
    expect(conflict?.providerId).toBe("podman");
    expect(conflict?.operation).toBe("select");
    expect(conflict?.remediation).toContain("lando setup --provider=");
    expect(conflict?.remediation).toContain("provider=podman");
    expect(conflict?.remediation).toContain("provider=lando");
    expect(conflict?.message).toContain("Podman socket");
    expect(conflict?.message).toContain("@lando/provider-lando");
    const details = conflict?.details as { socketPath?: string; providerLandoStatePath?: string };
    expect(details.socketPath).toBe("/run/user/1000/podman/podman.sock");
    expect(details.providerLandoStatePath).toBe(statePath);
  });

  test("normalizes trailing slashes when comparing sockets", async () => {
    await writeProviderLandoState(workDir, "/run/user/1000/podman/podman.sock/");
    const conflicts = await Effect.runPromise(
      detectProviderConflicts({
        stateDir: workDir,
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    );
    expect(conflicts).toHaveLength(1);
  });

  test("propagates ProviderLandoStateError for malformed state file", async () => {
    const path = join(workDir, "provider-lando");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "setup-state.json"), "this is not JSON", "utf8");

    const exit = await Effect.runPromiseExit(
      detectProviderConflicts({
        stateDir: workDir,
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
