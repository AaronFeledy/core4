import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import {
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  makeProviderLayer,
  setupProviderLando,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";

const podmanCommand = (version: string) => ({ version: Effect.succeed(version) });

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
    process.env.LANDO_TEST_PODMAN_SOCKET = undefined;

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
        process.env.LANDO_TEST_PODMAN_SOCKET = undefined;
      } else {
        process.env.LANDO_TEST_PODMAN_SOCKET = previousSocket;
      }
    }
  });

  test("succeeds with a reachable socket and reports the detected Podman version", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
            podmanCommand: podmanCommand("podman version 5.2.0"),
          }),
        ),
      ),
    );

    await Effect.runPromise(Effect.scoped(provider.setup({ force: false })));

    const versions = await Effect.runPromise(provider.getVersions);
    expect(versions.runtime).toBe("5.2.0");
  });
});
