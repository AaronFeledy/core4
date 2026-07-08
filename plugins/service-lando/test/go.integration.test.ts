import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTooling } from "@lando/core/cli/operations";
import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type ProviderCapabilities,
  RuntimeProvider,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { DateTime, Effect, Layer, Schema } from "effect";

import { ProviderExecToolingEngineLive } from "../../../core/src/services/tooling-engine.ts";
import { emptyConfigServiceLayer } from "../../../core/test/cli/agent-env-test-config.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("gointtest");
const GO_PORT = 31082;

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-27T00:00:00Z"),
  source: "go.integration.test",
  runtime: 4 as const,
};

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const GO_MAIN_SRC = `package main

import (
\t"fmt"
\t"net/http"
)

func main() {
\thttp.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
\t\tfmt.Fprint(w, "lando-go-ok")
\t})
\t_ = http.ListenAndServe(":${GO_PORT}", nil)
}
`;

const GO_MOD_SRC = `module lando.local/gotest

go 1.22
`;

const goServicePlan = (appRoot: AbsolutePath): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "go:1.22",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "golang:1.22" },
  command: ["go", "run", "/app/main.go"],
  environment: { GOFLAGS: "-mod=mod" },
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [{ port: GO_PORT, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const waitForHttp = async (url: string, timeoutMs: number): Promise<Response> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`HTTP endpoint not ready at ${url} within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("go service type — live integration: minimal Go HTTP server + lando go version", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "boots a Go service, serves HTTP from the bind-mounted main.go, and runs `lando go version` through tooling",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath ?? "";
      expect(socketPath).toBeTruthy();

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-go-int-"));
      try {
        await writeFile(join(appRootStr, "main.go"), GO_MAIN_SRC);
        await writeFile(join(appRootStr, "go.mod"), GO_MOD_SRC);

        const appRoot = AbsolutePath.make(appRootStr);
        const web = goServicePlan(appRoot);
        const plan: AppPlan = {
          id: appId,
          name: "Go Integration App",
          slug: "gointtest",
          root: appRoot,
          provider: providerId,
          services: { [web.name]: web },
          routes: [],
          networks: [],
          stores: [],
          metadata,
          extensions: {},
        };

        const api = makePodmanApiClient(socketPath);
        const provider = await Effect.runPromise(
          RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: api }))),
        );

        try {
          const applied = await Effect.runPromise(bringUp(plan, { podmanApi: api }));
          expect(applied.changed).toBe(true);

          // `go run` needs time to compile before it starts serving; allow generous headroom.
          const response = await waitForHttp(`http://127.0.0.1:${GO_PORT}`, 120_000);
          expect(await response.text()).toBe("lando-go-ok");

          // Verify `lando go version` runs through the tooling path on the live provider.
          const landofile = Schema.decodeUnknownSync(LandofileShape)({
            name: "gointtest",
            services: { web: { type: "go:1.22" } },
            tooling: { go: { service: "web", cmd: "go" } },
          });

          const toolingLayer = Layer.mergeAll(
            Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
            Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
            Layer.succeed(RuntimeProviderRegistry, {
              list: Effect.succeed([providerId]),
              capabilities: Effect.succeed(capabilities),
              select: () => Effect.succeed(provider),
            }),
            ProviderExecToolingEngineLive,
            emptyConfigServiceLayer,
          );

          const result = await Effect.runPromise(
            runTooling({ name: "go", args: ["version"] }).pipe(Effect.provide(toolingLayer)),
          );

          expect(result.tool).toBe("go");
          expect(result.service).toBe("web");
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/go version go1\.22/u);
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    // Image pull (~850MB), `go run` compile, endpoint polling, exec, and teardown can take a while.
    240_000,
  );
});
