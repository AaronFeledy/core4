import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Exit } from "effect";

import { providerStatePath } from "@lando/provider-lando";
import {
  ProviderLandoConflictError,
  ProviderLandoStateError,
  detectProviderLandoConflict,
  makeRuntimeProvider,
} from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";

const writeProviderLandoState = async (
  stateDir: string,
  state: {
    readonly podmanVersion?: string;
    readonly socketPath?: string;
  },
): Promise<string> => {
  const providerDir = path.join(stateDir, "provider-lando");
  await mkdir(providerDir, { recursive: true });
  const statePath = providerStatePath(stateDir);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
};

describe("provider-podman provider-lando conflict detection", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "lando-provider-podman-conflict-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test("returns success when no provider-lando setup state exists", async () => {
    await expect(
      Effect.runPromise(detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock")),
    ).resolves.toBeUndefined();
  });

  test("returns success when setup state has no socketPath", async () => {
    await writeProviderLandoState(stateDir, { podmanVersion: "6.0.2" });
    await expect(
      Effect.runPromise(detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock")),
    ).resolves.toBeUndefined();
  });

  test("fails closed when provider-lando setup state is malformed", async () => {
    const providerDir = path.join(stateDir, "provider-lando");
    await mkdir(providerDir, { recursive: true });
    await writeFile(providerStatePath(stateDir), "not valid json");

    const exit = await Effect.runPromiseExit(
      detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock"),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const error = cause._tag === "Fail" ? cause.error : undefined;
      expect(error).toBeInstanceOf(ProviderLandoStateError);
    }
  });

  test("fails closed when provider-lando setup state has non-string socketPath", async () => {
    const providerDir = path.join(stateDir, "provider-lando");
    await mkdir(providerDir, { recursive: true });
    await writeFile(providerStatePath(stateDir), `${JSON.stringify({ socketPath: 42 })}\n`);

    const exit = await Effect.runPromiseExit(
      detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock"),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const error = cause._tag === "Fail" ? cause.error : undefined;
      expect(error).toBeInstanceOf(ProviderLandoStateError);
    }
  });

  test("returns success when recorded socket differs from resolved socket", async () => {
    await writeProviderLandoState(stateDir, {
      podmanVersion: "6.0.2",
      socketPath: "/different/socket.sock",
    });
    await expect(
      Effect.runPromise(detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock")),
    ).resolves.toBeUndefined();
  });

  test("fails with ProviderLandoConflictError when recorded socket matches", async () => {
    const recorded = "/run/user/1000/podman/podman.sock";
    const statePath = await writeProviderLandoState(stateDir, {
      podmanVersion: "6.0.2",
      socketPath: recorded,
    });

    const exit = await Effect.runPromiseExit(detectProviderLandoConflict(stateDir, recorded));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const error = cause._tag === "Fail" ? cause.error : undefined;
      expect(error).toBeInstanceOf(ProviderLandoConflictError);
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      if (error instanceof ProviderLandoConflictError) {
        expect(error.providerId).toBe("podman");
        expect(error.operation).toBe("select");
        expect(error.message).toContain(recorded);
        expect(error.message).toContain(statePath);
        expect(error.remediation).toContain("lando setup --provider=podman");
      }
    }
  });

  test("normalizes trailing slashes when comparing sockets", async () => {
    await writeProviderLandoState(stateDir, {
      socketPath: "/run/user/1000/podman/podman.sock/",
    });
    const exit = await Effect.runPromiseExit(
      detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("strips unix:// prefix when comparing sockets", async () => {
    await writeProviderLandoState(stateDir, {
      socketPath: "unix:///run/user/1000/podman/podman.sock",
    });
    const exit = await Effect.runPromiseExit(
      detectProviderLandoConflict(stateDir, "/run/user/1000/podman/podman.sock"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("makeRuntimeProvider rejects opt-in when provider-lando conflict is recorded", async () => {
    await writeProviderLandoState(stateDir, {
      podmanVersion: "6.0.2",
      socketPath: "/run/test/podman.sock",
    });

    const exit = await Effect.runPromiseExit(
      makeRuntimeProvider({
        platform: "linux",
        env: { LANDO_TEST_PODMAN_SOCKET: "/run/test/podman.sock" },
        stateDir,
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const error = cause._tag === "Fail" ? cause.error : undefined;
      expect(error).toBeInstanceOf(ProviderLandoConflictError);
    }
  });

  test("makeRuntimeProvider succeeds when conflict detector reports no conflict", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: { LANDO_TEST_PODMAN_SOCKET: "/run/test/podman.sock" },
        stateDir,
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
      }),
    );
    expect(provider.id).toBe("podman");
  });

  test("custom conflictDetector takes precedence over the file-based one", async () => {
    await writeProviderLandoState(stateDir, {
      socketPath: "/run/test/podman.sock",
    });
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: { LANDO_TEST_PODMAN_SOCKET: "/run/test/podman.sock" },
        stateDir,
        conflictDetector: () => Effect.void,
        podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
      }),
    );
    expect(provider.id).toBe("podman");
  });
});
