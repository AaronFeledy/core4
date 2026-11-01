import { expect, test } from "bun:test";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { AppId, AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { makeRuntimeProvider } from "./provider-fixture.ts";

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "shutdown-app",
  name: "Shutdown",
  slug: "shutdown-app",
  root: "/shutdown-app",
  provider: "podman",
  services: {
    web: {
      name: "web",
      type: "compose",
      provider: "podman",
      primary: true,
      artifact: { kind: "ref", ref: "busybox:1.37" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata: { source: "shutdown", runtime: 4, resolvedAt: "2026-01-01T00:00:00Z" },
    },
  },
  stores: [],
  routes: [],
  fileSync: [],
  extensions: {},
  metadata: { source: "shutdown", runtime: 4, resolvedAt: "2026-01-01T00:00:00Z" },
});

test.each(["destroy", "observed"] as const)(
  "Podman %s receipt retains exact shutdown facts",
  async (operation) => {
    // Given
    const calls: EngineHttpRequest[] = [];
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        conflictDetector: () => Effect.void,
        podmanApi: {
          info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
          ping: Effect.void,
          request: (input) => {
            calls.push(input);
            if (input.method !== "GET") return Effect.succeed({ status: 204, body: "" });
            if (input.path.startsWith("/networks/")) return Effect.succeed({ status: 404, body: "" });
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({
                Id: "owned-id",
                Config: {
                  Labels: {
                    "dev.lando.app": plan.id,
                    "dev.lando.app-root": plan.root,
                    "dev.lando.service": "web",
                  },
                },
                State: { Status: "exited", ExitCode: 137, OOMKilled: true },
              }),
            });
          },
        },
      }),
    );
    // When
    const receipt =
      operation === "destroy"
        ? await Effect.runPromise(provider.destroy({ app: plan.id, plan }, { volumes: false }))
        : await Effect.runPromise(
            provider.removeObservedService({
              app: AppId.make("shutdown-app"),
              providerId: ProviderId.make("podman"),
              service: ServiceName.make("web"),
              status: "running",
              publications: { status: "unknown" },
              containerId: "owned-id",
            }),
          );
    // Then
    expect(receipt).toMatchObject({
      kind: operation === "destroy" ? "destroyed" : "removed",
      shutdownObservations: [
        {
          appId: plan.id,
          providerId: "podman",
          service: "web",
          containerId: "owned-id",
          status: "exited",
          exitCode: 137,
          oomKilled: true,
        },
      ],
    });
    expect(calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
      "/containers/owned-id/stop",
      "/containers/owned-id?force=true&v=true",
    ]);
  },
);
