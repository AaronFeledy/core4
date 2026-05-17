import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  RuntimeBundleVerificationError,
  makeProviderLayer,
  providerStatePath,
  setupProviderLando,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";

const podmanCommand = (version: string) => ({ version: Effect.succeed(version) });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("provider-lando setup", () => {
  test("fails with remediation when Podman is not installed", async () => {
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        podmanCommand: { version: Effect.fail(new PodmanNotInstalledError()) },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        expect(failure.value).toBeInstanceOf(PodmanNotInstalledError);
        expect(failure.value.remediation).toContain("Install Podman >=");
      }
    }
  });

  test("fails with remediation when the Podman socket is not reachable", async () => {
    const previousSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
    // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
    delete process.env.LANDO_TEST_PODMAN_SOCKET;

    try {
      const exit = await Effect.runPromiseExit(
        setupProviderLando({ podmanCommand: podmanCommand("podman version 5.2.0") }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
          expect(failure.value).toBeInstanceOf(PodmanSocketUnreachableError);
          expect(failure.value.remediation).toBe(
            "Run `systemctl --user start podman.socket` and rerun `lando setup`.",
          );
        }
      }
    } finally {
      if (previousSocket === undefined) {
        // biome-ignore lint/performance/noDelete: process.env coerces undefined to the string "undefined"; delete is required to truly unset an env var
        delete process.env.LANDO_TEST_PODMAN_SOCKET;
      } else {
        process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
      }
    }
  });

  test("succeeds with a reachable socket and reports the detected Podman version", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-state-"));
    const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
            podmanCommand: podmanCommand("podman version 5.2.0"),
            runtimeBundleDownloader: {
              download: Effect.succeed({
                version: "0.0.0-test",
                bytes: bundleBytes,
                sha256: sha256(bundleBytes),
              }),
            },
            stateDir,
          }),
        ),
      ),
    );

    try {
      await Effect.runPromise(Effect.scoped(provider.setup({ force: false })));

      const versions = await Effect.runPromise(provider.getVersions);
      expect(versions.runtime).toBe("5.2.0");

      const state = JSON.parse(await readFile(providerStatePath(stateDir), "utf8"));
      expect(state).toEqual({
        podmanVersion: "5.2.0",
        runtimeBundleVersion: "0.0.0-test",
        runtimeBundleSha256: sha256(bundleBytes),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("fails closed when the runtime bundle checksum does not match", async () => {
    const bundleBytes = new TextEncoder().encode("tampered lando runtime bundle");
    const exit = await Effect.runPromiseExit(
      setupProviderLando({
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: podmanCommand("podman version 5.2.0"),
        runtimeBundleDownloader: {
          download: Effect.succeed({ version: "0.0.0-test", bytes: bundleBytes, sha256: "bad-checksum" }),
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
        expect(failure.value).toBeInstanceOf(RuntimeBundleVerificationError);
        expect(failure.value.remediation).toContain("checksum");
      }
    }
  });
});
