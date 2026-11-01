import { expect, test } from "bun:test";
import { type AppPlan, ProviderId } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { withRetainedAgentOverlays } from "../../src/operations/restart-agent-overlays.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test.each([
  { provider: "lando", globalProvider: "docker", runtimeVolume: "foreign-agent" },
  { provider: "docker", globalProvider: "lando", runtimeVolume: "foreign-agent" },
  { provider: "docker", globalProvider: "docker", runtimeVolume: undefined },
])(
  "does not reconstruct an unavailable local sidecar volume for $provider / $globalProvider / $runtimeVolume",
  async ({ provider, globalProvider, runtimeVolume }) => {
    const desired: AppPlan = {
      ...plan,
      provider: ProviderId.make(provider),
      extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } },
      services: { [web.name]: { ...web, extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } } } },
    };
    const harness = makeHarness({ plannedApp: desired });
    const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
    const result = await Effect.runPromise(
      withRetainedAgentOverlays(desired, { kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provideService(GlobalAppService, {
          ...globalApp,
          providerId: Effect.succeed(ProviderId.make(globalProvider)),
        }),
        Effect.provideService(SshService, {
          id: "sidecar",
          setup: () => Effect.die("selected restart must not start a sidecar"),
          getAgentSocket: (appId) =>
            Effect.succeed({
              appId,
              socketPath: "/unused",
              ...(runtimeVolume === undefined ? {} : { runtimeVolume }),
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    expect(result).toEqual(desired);
  },
);

test("does not reconstruct a sidecar volume without global-app placement", async () => {
  // Given
  const desired: AppPlan = {
    ...plan,
    extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } },
    services: { [web.name]: { ...web, extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } } } },
  };
  const harness = makeHarness({ plannedApp: desired });
  const paths = await Effect.runPromise(PathsService.pipe(Effect.provide(harness.layer)));
  const privateFileAccess = await Effect.runPromise(
    PrivateFileAccessService.pipe(Effect.provide(harness.layer)),
  );

  // When
  const result = await Effect.runPromise(
    withRetainedAgentOverlays(desired, { kind: "user", id: plan.id, root: plan.root }).pipe(
      Effect.provideService(PathsService, paths),
      Effect.provideService(PrivateFileAccessService, privateFileAccess),
      Effect.provideService(SshService, {
        id: "sidecar",
        setup: () => Effect.die("selected restart must not start a sidecar"),
        getAgentSocket: (appId) =>
          Effect.succeed({ appId, socketPath: "/unused", runtimeVolume: "unplaced-agent" }),
      }),
    ),
  );

  // Then
  expect(result).toEqual(desired);
});
