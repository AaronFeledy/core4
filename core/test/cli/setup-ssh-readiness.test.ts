import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDownloader, makeTestInteractionService } from "@lando/core/testing";
import * as LandoHttpClient from "@lando/http-client";
import { AppId, GlobalConfig, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  ConfigService,
  Downloader,
  EventService,
  InteractionService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestSshService } from "@lando/sdk/test";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { runShellServiceSetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import { makeSetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import { setupSpec } from "../../src/cli/command-specs/meta/setup.ts";
import { type SetupReadinessStep, readSetupReadiness } from "../../src/cli/commands/setup-readiness.ts";

test.each([
  { state: "running", exitCode: 0, status: "satisfied", probes: 1 },
  { state: "running", exitCode: 2, status: "unavailable", probes: 60 },
  { state: "exited", exitCode: 0, status: "unavailable", probes: 0 },
] as const)(
  "setup records $status when sidecar is $state with agent probe exit $exitCode",
  async (scenario) => {
    // Given: the real setup command with an isolated record and a provider boundary double.
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-ssh-readiness-"));
    const warnings: string[] = [];
    const selections: string[] = [];
    const inspecting = Effect.runSync(Deferred.make<void>());
    let probes = 0;
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "native" as const },
      inspect: () =>
        Effect.succeed({
          app: AppId.make("global"),
          service: ServiceName.make("ssh-agent"),
          providerId: ProviderId.make("lando"),
          status: scenario.state,
        }).pipe(Effect.tap(() => Deferred.succeed(inspecting, undefined))),
      exec: () =>
        Effect.sync(() => {
          probes++;
          return { exitCode: scenario.exitCode, stdout: "", stderr: "" };
        }),
    };
    const config = Schema.decodeUnknownSync(GlobalConfig)({ userDataRoot, defaultProviderId: "lando" });
    const downloader = Effect.runSync(makeTestDownloader());
    const interaction = makeTestInteractionService();
    const ssh = makeTestSshService();
    const events = EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          if (event._tag === "message.warn" && typeof event.body === "string") warnings.push(event.body);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.die("unused subscription"),
      waitFor: () => Effect.die("unused event wait"),
      waitForAny: () => Effect.die("unused event wait"),
      query: () => Effect.succeed([]),
    });
    try {
      // When: setup runs and the existing readiness budget elapses on a virtual clock.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            setupSpec.run({
              installDir: "/opt/lando",
              flags: {
                "skip-provider": true,
                "skip-install-ca": true,
                "skip-proxy": true,
                "no-interactive": true,
              },
            }),
          );
          yield* Deferred.await(inspecting);
          yield* TestClock.adjust("30 seconds");
          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ConfigService, {
                load: Effect.succeed(config),
                get: (key) => Effect.succeed(config[key]),
              }),
              Layer.succeed(RuntimeProviderRegistry, {
                list: Effect.succeed([ProviderId.make("lando")]),
                capabilities: Effect.succeed(provider.capabilities),
                select: (plan) =>
                  Effect.sync(() => {
                    selections.push(typeof plan === "string" ? plan : (plan?.provider ?? "default"));
                    return provider;
                  }),
              }),
              Layer.succeed(SshService, { ...ssh, id: "sidecar" }),
              Layer.succeed(EventService, events),
              Layer.succeed(Downloader, downloader.service),
              Layer.succeed(InteractionService, interaction.service),
              LandoHttpClient.layer,
              TestClock.layer(),
            ),
          ),
        ),
      );
      const readiness = await Effect.runPromise(readSetupReadiness(userDataRoot));
      const shell = readiness?.steps.find((step) => step.id === "shell");
      // Then: an unavailable agent warns, but later setup steps still run and setup succeeds.
      expect(result).toMatchObject({ providerId: "lando", fileSyncStatus: "satisfied" });
      expect(shell?.status).toBe(scenario.status);
      expect(probes).toBe(scenario.probes);
      expect(selections).not.toContain("default");
      expect(ssh.calls).toEqual([{ op: "setup", opts: { force: false } }]);
      if (scenario.status === "unavailable") {
        expect(readiness?.status).toBe("failed");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(shell?.evidence ?? "missing evidence");
        expect(warnings[0]).toContain(shell?.remediation ?? "missing remediation");
        expect(shell?.evidence).toContain(scenario.state === "exited" ? "stopped" : "30 seconds");
        expect(shell?.remediation).toContain("lando setup");
      } else {
        expect(warnings).toEqual([]);
      }
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each([
  { id: "host", skip: false, status: "satisfied" },
  { id: "test", skip: false, status: "satisfied" },
  { id: "sidecar", skip: true, status: "skipped" },
] as const)("shell step preserves $id behavior when skip=$skip", async ({ id, skip, status }) => {
  // Given
  const steps: SetupReadinessStep[] = [];
  const ssh = makeTestSshService();
  const recorder = {
    ...makeSetupReadinessRecorder(undefined, "lando"),
    record: (step: SetupReadinessStep) =>
      Effect.sync(() => {
        steps.push(step);
      }),
  };
  // When
  await Effect.runPromise(
    runShellServiceSetupStep({ flags: { "skip-shell-integration": skip } }, recorder).pipe(
      Effect.provideService(SshService, { ...ssh, id }),
    ),
  );
  // Then: no runtime registry is needed for other implementations or a skipped sidecar.
  expect(steps.map((step) => step.status)).toEqual([status]);
  expect(ssh.calls).toHaveLength(skip ? 0 : 1);
});
