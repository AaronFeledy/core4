import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { layer as plannerLayer } from "@lando/engine/services/planner";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makePodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import { PluginLoadError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const liveSocket = resolveLiveProviderSocket();

test.skipIf(liveSocket === undefined)(
  "connects from a planned Podman container to the host over TCP using the alias and LANDO_HOST_IP",
  async () => {
    // Given
    const token = crypto.randomUUID();
    const name = `host-tcp-${token}`;
    const stateDir = await mkdtemp(join(tmpdir(), "lando-host-tcp-"));
    const listener = Bun.listen({
      hostname: "0.0.0.0",
      port: 0,
      socket: {
        open(socket) {
          socket.end(token);
        },
        data() {},
      },
    });
    const serviceType: ServiceType = {
      id: "host-probe",
      name: "Host TCP probe",
      base: "l337",
      schema: Schema.Unknown,
      resolve: (input) =>
        Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [{ id: "probe.image" }] }),
    };
    const unsupported = (id: string) =>
      Effect.fail(new PluginLoadError({ pluginName: id, message: `Unexpected plugin ${id}` }));
    const registry = Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([]),
        load: unsupported,
        loadServiceType: () => Effect.succeed(serviceType),
        loadServiceFeature: () =>
          Effect.succeed({
            id: "probe.image",
            priority: 100,
            apply: (ctx) =>
              Effect.sync(() => {
                ctx.setArtifact({ kind: "ref", ref: "node:22-alpine" });
                ctx.setCommand(["node", "-e", "setInterval(() => {}, 1000)"]);
              }),
          }),
        loadAppFeature: unsupported,
      }),
    );
    try {
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          podmanApi: makePodmanApiClient(liveSocket?.socketPath ?? ""),
          appliedPlanState: makePluginStateStore(
            makeTestStateStore().service,
            AbsolutePath.make(stateDir),
            ownerOnlyFileAccess,
          ),
        }),
      );
      const service = ServiceName.make("probe");
      const plan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(
            {
              name,
              runtime: 4,
              provider: ProviderId.make("podman"),
              services: { [service]: { type: serviceType.id, home: false, appMount: false } },
            },
            provider.capabilities,
          ),
        ).pipe(Effect.provide(plannerLayer), Effect.provide(registry)),
      );
      try {
        // When
        await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
        for (const host of ['"host.lando.internal"', "process.env.LANDO_HOST_IP"]) {
          const result = await Effect.runPromise(
            provider.exec(
              { app: plan.id, service, plan },
              {
                command: [
                  "node",
                  "-e",
                  `const s = require("node:net").connect({host: ${host}, port: ${listener.port}}); s.setTimeout(5000, () => { s.destroy(); process.exit(2); }); s.on("data", b => process.stdout.write(b)); s.on("error", e => { process.stderr.write(e.message); process.exit(1); });`,
                ],
              },
            ),
          );
          // Then
          expect(result).toMatchObject({ exitCode: 0, stdout: token, stderr: "" });
        }
      } finally {
        await Effect.runPromise(provider.destroy({ app: plan.id, plan }, { volumes: true }));
      }
    } finally {
      listener.stop(true);
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  120_000,
);
