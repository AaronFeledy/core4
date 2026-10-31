import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { makeLandoPaths } from "@lando/paths";

import { FileNotFoundError, GlobalAppError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  FileSystem,
  GlobalAppService,
  PathsService,
  RouterService,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { layer, makeTraefikRouterService } from "../src/proxy.ts";
import { makeApplyRuntime } from "./apply-runtime-fixture.ts";

const root = "/lando/global/proxy-traefik";
const marker = `${root}/dynamic/.lando-routing-state`;
const fallback = `${root}/dynamic/fallback.yml`;
const watcher = `${root}/watcher-diagnostic.json`;

const fixture = () => {
  let state: "running" | "stopped" | "unknown" = "running";
  let observationFailure = false;
  let onObservation = () => {};
  let markerReadFailure: Error | undefined;
  let markerRemovalFailure: Error | undefined;
  let probes = 0;
  let logs = 0;
  const files = new Map([
    [marker, "http://127.0.0.1:8080\nhttps://127.0.0.1:8443"],
    [fallback, "retained fallback configuration"],
    [watcher, "previous watcher failure"],
  ]);
  const service = makeTraefikRouterService({
    readTraefikState: () =>
      Effect.suspend(() => {
        onObservation();
        return observationFailure ? Effect.fail(new Error("provider unavailable")) : Effect.succeed(state);
      }),
    readTraefikLogs: () => {
      logs += 1;
      return Effect.succeed({ providerId: "lando", text: "Healthy startup" });
    },
    probeForward: () => {
      probes += 1;
      return Effect.succeed({ kind: "success" as const });
    },
    certificateAuthority: makeTestCertificateAuthority(),
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: { ensureRunning: () => Effect.die("observation must not start services") },
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) => Effect.succeed(path === `${root}/dynamic` || files.has(path)),
      readDir: () => Effect.succeed([]),
      readText: (path) =>
        path === marker && markerReadFailure !== undefined
          ? Effect.fail(markerReadFailure)
          : files.has(path)
            ? Effect.succeed(files.get(path) ?? "")
            : Effect.fail(new FileNotFoundError({ message: "missing", path })),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) =>
        path === marker && markerRemovalFailure !== undefined
          ? Effect.fail(markerRemovalFailure)
          : files.has(path)
            ? Effect.sync(() => void files.delete(path))
            : Effect.fail(new FileNotFoundError({ message: "already removed", path })),
    },
  });
  return {
    service,
    files,
    setState: (next: typeof state) => {
      state = next;
    },
    failObservation: () => {
      observationFailure = true;
    },
    onObservation: (hook: () => void) => {
      onObservation = hook;
    },
    failMarkerRead: (error: Error) => {
      markerReadFailure = error;
    },
    failMarkerRemoval: (error: Error) => {
      markerRemovalFailure = error;
    },
    calls: () => ({ probes, logs }),
  };
};

for (const observed of ["stopped", "unknown", "failure"] as const) {
  test(`startup revalidation invalidates a previously running marker when the router is ${observed}`, async () => {
    const harness = fixture();
    expect((await Effect.runPromise(harness.service.status)).state).toBe("running");
    if (observed === "failure") harness.failObservation();
    else harness.setState(observed);

    await Effect.runPromise(harness.service.revalidateStartup);

    expect(harness.calls()).toEqual({ probes: 0, logs: 0 });
    expect(harness.files.has(marker)).toBe(false);
    expect(harness.files.get(watcher)).toBe("previous watcher failure");
    expect(harness.files.get(fallback)).toBe("retained fallback configuration");
    expect((await Effect.runPromise(harness.service.status)).state).toBe("stopped");
  });
}

test("status never treats a saved ready marker as evidence of a stopped router", async () => {
  const harness = fixture();
  harness.setState("stopped");
  const status = await Effect.runPromise(harness.service.status);
  expect(status.state).toBe("stopped");
  expect(status.ports).toBeUndefined();
  expect(harness.files.has(marker)).toBe(false);
  expect(harness.files.get(watcher)).toBe("previous watcher failure");
  expect(harness.calls()).toEqual({ probes: 0, logs: 0 });
});

test("startup revalidation tolerates concurrent marker removal and preserves other removal errors", async () => {
  const harness = fixture();
  harness.setState("stopped");
  harness.onObservation(() => {
    harness.files.delete(marker);
  });

  await Effect.runPromise(harness.service.revalidateStartup);

  expect(harness.files.has(marker)).toBe(false);
  expect(harness.files.get(watcher)).toBe("previous watcher failure");
  expect(harness.calls()).toEqual({ probes: 0, logs: 0 });

  const failure = new Error("marker removal denied");
  harness.failMarkerRemoval(failure);
  expect(await Effect.runPromise(Effect.result(harness.service.revalidateStartup))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProxyError", cause: failure },
  });
});

test("a running router still probes startup and refreshes its watcher observation", async () => {
  const harness = fixture();
  await Effect.runPromise(harness.service.revalidateStartup);
  expect(harness.calls()).toEqual({ probes: 2, logs: 1 });
  expect(harness.files.has(marker)).toBe(true);
  expect(harness.files.has(watcher)).toBe(false);
  expect((await Effect.runPromise(harness.service.status)).state).toBe("running");
});

for (const state of ["running", "stopped"] as const) {
  test(`status tolerates marker removal during ${state} runtime observation without advertising ports`, async () => {
    const harness = fixture();
    harness.setState(state);
    harness.onObservation(() => {
      harness.files.delete(marker);
    });

    const status = await Effect.runPromise(harness.service.status);

    expect(status.state).toBe("stopped");
    expect(status.ports).toBeUndefined();
    expect(harness.files.get(watcher)).toBe("previous watcher failure");
  });
}

for (const operation of ["read", "remove"] as const) {
  test(`status preserves a non-missing marker ${operation} failure`, async () => {
    const harness = fixture();
    const failure = new Error(`marker ${operation} denied`);
    if (operation === "read") harness.failMarkerRead(failure);
    else {
      harness.setState("stopped");
      harness.failMarkerRemoval(failure);
    }

    const result = await Effect.runPromise(Effect.result(harness.service.status));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyError", cause: failure } });
    expect(harness.files.has(marker)).toBe(true);
  });
}

test.each([false, true])(
  "the production layer isolates its embedded root (path failure: %s)",
  async (pathFailure) => {
    const embeddedRoot = "/embedded/global";
    const defaultPaths = makeLandoPaths({ userDataRoot: "/different-data", platform: "linux", env: {} });
    const embeddedMarker = `${embeddedRoot}/proxy-traefik/dynamic/.lando-routing-state`;
    const foreignMarker = `${defaultPaths.globalAppRoot}/proxy-traefik/dynamic/.lando-routing-state`;
    const files = new Map([
      [embeddedMarker, "old embedded readiness"],
      [foreignMarker, "foreign readiness"],
    ]);
    const write = (path: string, value: string | Uint8Array) =>
      Effect.sync(() => void files.set(path, String(value)));
    const read = (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path) ?? "")
        : Effect.fail(new FileNotFoundError({ message: "missing", path }));
    const fileSystem = FileSystem.of({
      read: () => Stream.empty,
      readText: read,
      readFile: read,
      write,
      writeAtomic: write,
      writeFile: write,
      exists: (path) => Effect.succeed(files.has(path) || path.endsWith("/dynamic")),
      mkdir: () => Effect.void,
      remove: (path) => Effect.sync(() => void files.delete(path)),
      readDir: () => Effect.succeed([]),
      stat: () => Effect.die("unused"),
      lstat: () => Effect.die("unused"),
    });
    const globalApp = GlobalAppService.of({
      id: "global",
      providerId: Effect.succeed(ProviderId.make("lando")),
      root: Effect.succeed(AbsolutePath.make(embeddedRoot)),
      paths: pathFailure
        ? Effect.fail(
            new GlobalAppError({
              operation: "paths",
              message: "Embedded root is unavailable.",
              remediation: "Repair the embedded global root.",
            }),
          )
        : Effect.succeed({
            root: AbsolutePath.make(embeddedRoot),
            distLandofile: AbsolutePath.make(`${embeddedRoot}/.lando.dist.yml`),
            userLandofile: AbsolutePath.make(`${embeddedRoot}/.lando.yml`),
          }),
      ensureRoot: Effect.void,
      ensureUserLandofile: Effect.die("unused"),
      ensureRunning: () => Effect.die("status must not start services"),
      regenerateDist: () => Effect.die("unused"),
    });
    const stateStore: PluginStateStore = { open: () => Effect.die("unused"), withLock: (_key, body) => body };
    const dependencies = Layer.mergeAll(
      Layer.succeed(FileSystem, fileSystem),
      Layer.succeed(GlobalAppService, globalApp),
      Layer.succeed(PathsService, defaultPaths),
      Layer.succeed(CertificateAuthority, makeTestCertificateAuthority()),
      Layer.succeed(HttpClient.HttpClient, makeApplyRuntime(files).httpClient),
    );
    const program = Effect.flatMap(RouterService, (router) => router.status).pipe(
      Effect.provide(layer(stateStore).pipe(Layer.provide(dependencies))),
    );
    if (pathFailure) {
      expect(await Effect.runPromise(Effect.result(program))).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProxyError",
          proxyId: "traefik",
          remediation: "Repair the embedded global root.",
          cause: { _tag: "GlobalAppError", operation: "paths" },
        },
      });
      expect(files.get(embeddedMarker)).toBe("old embedded readiness");
      expect(files.get(foreignMarker)).toBe("foreign readiness");
      return;
    }
    const status = await Effect.runPromise(program);
    expect(status.state).toBe("stopped");
    expect(files.has(embeddedMarker)).toBe(false);
    expect(files.get(foreignMarker)).toBe("foreign readiness");
  },
);
