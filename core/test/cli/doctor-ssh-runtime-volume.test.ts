import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  GlobalConfig,
  type HealthcheckPlan,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { ConfigService, GlobalAppService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { sshAgentPostureCheck } from "../../src/cli/commands/doctor-ssh-agent.ts";
import { setupReadinessPath, writeSetupReadiness } from "../../src/cli/commands/setup-readiness.ts";
import { globalAppForProvider } from "../_support/global-provider.ts";
import { globalPlanAt } from "../_support/global-teardown-harness.ts";

const testPaths = makeLandoPaths();
const runWithPaths = <A, E>(effect: Effect.Effect<A, E, PathsService>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(PathsService, testPaths)));

const root = AbsolutePath.make("/isolated/global");
const service = ServiceName.make("ssh-agent");
const readiness = {
  kind: "command",
  command: ["check-agent", "--ready"],
  user: "ssh-probe",
  intervalSeconds: 1,
  timeoutSeconds: 1,
  retries: 1,
} satisfies HealthcheckPlan;
const globalApp = {
  ...globalAppForProvider(ProviderId.make("lando")),
  paths: Effect.succeed({ root, distLandofile: root, userLandofile: root }),
};

test.each([
  ["running", readiness, "pass"],
  ["running", undefined, "warn"],
  ["exited", readiness, "warn"],
] as const)(
  "doctor observes a %s sidecar with readiness %j as %s without a host probe",
  async (state, readiness, expected) => {
    // Given
    let probes = 0;
    const plan = globalPlanAt(root, readiness);
    const provider = {
      ...TestRuntimeProvider,
      id: ProviderId.make("lando"),
      inspect: () =>
        Effect.succeed({
          app: AppId.make("global"),
          service,
          providerId: ProviderId.make("lando"),
          status: state,
          publications: { status: "present" as const, bindings: [] },
        }),
      exec: (target, opts) =>
        Effect.succeed({
          exitCode: target.user === "ssh-probe" && opts.command.join(" ") === "check-agent --ready" ? 0 : 2,
          stdout: "",
          stderr: "",
        }),
    } satisfies typeof TestRuntimeProvider;
    // When
    const check = await runWithPaths(
      sshAgentPostureCheck({
        globalConfig: {},
        capabilities: { agentSocket: { delivery: "guest-bridge" } },
        sshService: {
          id: "sidecar",
          setup: () => Effect.void,
          getAgentSocket: (appId) =>
            Effect.succeed({ appId, socketPath: "/unreachable.sock", runtimeVolume: "lando-ssh-agent" }),
        },
        probe: async () => {
          probes++;
          return { identities: 0 };
        },
      }).pipe(
        Effect.provideService(GlobalAppService, globalApp),
        Effect.provideService(
          RuntimeProviderRegistry,
          makeTestRuntimeProviderRegistry({
            resolveAppliedPlan: () => Effect.succeed(plan),
            list: Effect.succeed([provider.id]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ),
      ),
    );
    // Then
    expect(check.status).toBe(expected);
    expect(check.details).toMatchObject({
      delivery: "runtime-volume",
      runtimeVolume: "lando-ssh-agent",
      upstream: { reachable: expected === "pass" },
    });
    expect(probes).toBe(0);
  },
);

test.each([true, false])(
  "doctor repair keeps the setup record and requires runtime proof: %s",
  async (publishesReadiness) => {
    const userDataRoot = AbsolutePath.make(await mkdtemp(join(tmpdir(), "doctor-ssh-repair-")));
    const config = Schema.decodeUnknownSync(GlobalConfig)({ userDataRoot });
    try {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "lando", {
          status: "failed",
          steps: [{ id: "shell", status: "unavailable", evidence: "The agent did not answer." }],
        }),
      );
      const path = setupReadinessPath(userDataRoot);
      const before = await Bun.file(path).text();
      let converged = false;
      const provider = {
        ...TestRuntimeProvider,
        id: ProviderId.make("lando"),
        inspect: () =>
          Effect.succeed({
            app: AppId.make("global"),
            service,
            providerId: ProviderId.make("lando"),
            status: "running" as const,
            publications: { status: "unknown" as const },
          }),
        exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      };
      const check = await runWithPaths(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sshAgentPostureCheck({
              fix: true,
              env: {},
              capabilities: { agentSocket: { delivery: "bind-directory" } },
              sshService: {
                id: "sidecar",
                setup: () =>
                  Effect.sync(() => {
                    converged = true;
                  }),
                getAgentSocket: (appId) => Effect.succeed({ appId, socketPath: "/host-agent.sock" }),
              },
              probe: async () => {
                if (!converged) throw new Error("Socket has not been published.");
                return { identities: 2 };
              },
            }),
          );
          yield* TestClock.adjust("30 seconds");
          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(GlobalAppService, globalApp),
          Effect.provideService(ConfigService, {
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
          Effect.provideService(
            RuntimeProviderRegistry,
            makeTestRuntimeProviderRegistry({
              resolveAppliedPlan: () =>
                Effect.succeed(globalPlanAt(root, converged && publishesReadiness ? readiness : undefined)),
              list: Effect.succeed([provider.id]),
              capabilities: Effect.succeed(provider.capabilities),
              select: () => Effect.succeed(provider),
            }),
          ),
        ),
      );
      expect(check).toMatchObject({
        status: publishesReadiness ? "pass" : "warn",
        context: { fixOutcome: publishesReadiness ? "recovered" : "failed" },
        details: { upstream: { reachable: true, identities: 2 } },
      });
      expect(await Bun.file(path).text()).toBe(before);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  },
);
