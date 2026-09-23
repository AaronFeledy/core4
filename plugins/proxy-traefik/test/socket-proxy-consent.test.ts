import { expect, test } from "bun:test";
import { Effect, Schema, Stream } from "effect";

import { ProxyConfig } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import type { SocketProxyDependencies } from "../src/proxy-types.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { PROXYD_CANDIDATES } from "../src/socket-proxy-install.ts";

const harness = (isInteractive: boolean) => {
  const confirms: string[] = [];
  const elevations: (readonly string[])[] = [];
  const files = new Map<string, string>();
  const socketProxy: SocketProxyDependencies = {
    user: "test",
    hasHostSystemd: () => true,
    exists: (path) => Effect.succeed(PROXYD_CANDIDATES.some((candidate) => candidate === path)),
    readText: () => Effect.succeed(""),
    processRunner: {
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      stream: () => Stream.empty,
    },
    privilege: {
      elevate: (command) =>
        Effect.sync(() => {
          elevations.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    },
    interaction: {
      isInteractive: Effect.succeed(isInteractive),
      confirm: (spec) =>
        Effect.sync(() => {
          confirms.push(spec.name ?? "");
          return false;
        }),
    },
    classifyOverride: {
      http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
      https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
    },
    probeForward: () => Effect.succeed({ kind: "success" }),
  };
  const router = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) => Effect.succeed(files.has(path)),
      readText: (path) => Effect.succeed(files.get(path) ?? ""),
      readDir: () => Effect.succeed([]),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: { ensureRunning: () => Effect.succeed([]) },
    socketProxy,
  });
  return { router, confirms, elevations };
};

test("installs without calling confirm when TTY setup carries automatic consent", async () => {
  // Given: fresh helper state and a TTY that would decline.
  const { router, confirms, elevations } = harness(true);
  const config = Schema.decodeUnknownSync(ProxyConfig)({ defaultDomain: "lndo.site" });

  // When
  await Effect.runPromise(Effect.scoped(router.setup(config, { autoApprove: true })));

  // Then: the default install path runs without drawing a confirmation.
  expect(confirms).toEqual([]);
  expect(elevations).toHaveLength(1);
  expect(elevations[0]?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
});

test.each([undefined, false])("honors a TTY refusal when automatic consent is %j", async (autoApprove) => {
  // Given
  const { router, confirms, elevations } = harness(true);

  // When
  await Effect.runPromise(
    Effect.scoped(
      router.setup({ defaultDomain: "lndo.site" }, autoApprove === undefined ? undefined : { autoApprove }),
    ),
  );

  // Then
  expect(confirms).toEqual(["install-socket-proxy"]);
  expect(elevations).toEqual([]);
});

test("keeps default installation without confirmation on non-TTY input", async () => {
  // Given
  const { router, confirms, elevations } = harness(false);

  // When
  await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));

  // Then
  expect(confirms).toEqual([]);
  expect(elevations).toHaveLength(1);
});

test("does not grant consent from decoded proxy configuration", async () => {
  // Given: configuration containing an invocation-only flag and a refusing TTY.
  const { router, confirms, elevations } = harness(true);
  const config = Schema.decodeUnknownSync(ProxyConfig)({ defaultDomain: "lndo.site", autoApprove: true });

  // When
  await Effect.runPromise(Effect.scoped(router.setup(config)));

  // Then
  expect(confirms).toEqual(["install-socket-proxy"]);
  expect(elevations).toEqual([]);
});

test("does not retain approval for a subsequent setup invocation", async () => {
  // Given: a prior approved invocation; the fake host still reports no installed helper.
  const { router, confirms, elevations } = harness(true);
  await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" }, { autoApprove: true })));
  confirms.length = 0;
  elevations.length = 0;

  // When
  await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));

  // Then
  expect(confirms).toEqual(["install-socket-proxy"]);
  expect(elevations).toEqual([]);
});
