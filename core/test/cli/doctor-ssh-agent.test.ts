import { describe, expect, test } from "bun:test";
import { LandofileParseError, SshError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  GlobalConfig,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  ConfigService,
  GlobalAppService,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestSshService } from "@lando/sdk/test";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-report-contract.ts";
import { sshAgentPostureCheck } from "../../src/cli/commands/doctor-ssh-agent.ts";
import {
  DefaultSubsystemDoctorLayer,
  renderSubsystemDoctorResultAsNdjson,
  subsystemDoctor,
} from "../../src/cli/commands/doctor-subsystems.ts";
import { globalAppForProvider } from "../_support/global-provider.ts";

const inputs = () => ({
  globalConfig: {},
  platform: "linux",
  env: {},
  discovery: { home: "/home/test", exists: async () => false },
  capabilities: { agentSocket: { delivery: "bind-directory" as const } },
  sshService: {
    ...makeTestSshService(),
    id: "sidecar",
    getAgentSocket: (appId: AppId) =>
      Effect.succeed({ appId, socketPath: AbsolutePath.make("/test/agent.sock") }),
  },
  probe: async () => ({ identities: 0 }),
});

const runningSidecar = {
  ...TestRuntimeProvider,
  inspect: () =>
    Effect.succeed({
      app: AppId.make("global"),
      service: ServiceName.make("ssh-agent"),
      providerId: ProviderId.make("lando"),
      status: "running",
      publications: { status: "unknown" as const },
    }),
};
const sidecarRegistry = RuntimeProviderRegistry.of({
  appliedPlansFor: () => Effect.succeed([]),
  resolveAppliedPlan: () => Effect.succeed(undefined),
  resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  list: Effect.succeed([ProviderId.make("lando")]),
  capabilities: Effect.succeed(runningSidecar.capabilities),
  select: () => Effect.succeed(runningSidecar),
});

describe("SSH agent doctor posture", () => {
  test("Landofile sidecar false overrides global default in doctor", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "doctor-app",
      services: {},
      sshAgent: { sidecar: false, socket: "/app/agent.sock" },
    });
    const upstreams: unknown[] = [];
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...inputs(),
        globalConfig: { sshAgent: { sidecar: true, socket: "/global/agent.sock" } },
        discovery: { home: "/home/test", exists: async () => true },
        probe: async (upstream) => {
          upstreams.push(upstream);
          return { identities: 0 };
        },
      }).pipe(
        Effect.provideService(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed(literalLandofile(landofile, "/app")) }),
        ),
      ),
    );
    // Then
    expect(check).toMatchObject({
      status: "pass",
      details: { mode: "host", upstream: { source: "explicit" } },
    });
    expect(upstreams).toEqual([{ _tag: "unix", path: "/app/agent.sock", source: "explicit" }]);
  });

  test("doctor falls back to global intent when app resolution fails", async () => {
    // Given
    const failure = new LandofileParseError({
      message: "Invalid app file",
      filePath: "/app/.lando.yml",
      line: undefined,
      column: undefined,
    });
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...inputs(),
        globalConfig: { sshAgent: { sidecar: false } },
      }).pipe(
        Effect.provideService(LandofileService, LandofileService.of({ discover: Effect.fail(failure) })),
      ),
    );
    // Then
    expect(check).toMatchObject({
      status: "warn",
      details: { mode: "host", upstream: { reachable: false } },
    });
  });

  test("reports sidecar mode with sidecar reachability", async () => {
    // Given
    const input = inputs();
    const upstreams: unknown[] = [];
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...input,
        probe: async (upstream) => {
          upstreams.push(upstream);
          return { identities: 0 };
        },
      }),
    );
    // Then
    expect(upstreams).toEqual([{ _tag: "unix", path: "/test/agent.sock" }]);
    expect(check).toMatchObject({
      status: "pass",
      details: {
        mode: "sidecar",
        upstream: { source: "sidecar", reachable: true, identities: 0 },
        delivery: "bind-directory",
      },
    });
  });

  test("reports host mode with the discovered upstream source and no secrets", async () => {
    // Given
    const input = {
      ...inputs(),
      globalConfig: { sshAgent: { sidecar: false } },
      env: { SSH_AUTH_SOCK: "/host/agent.sock", API_TOKEN: "private-value" },
      discovery: { home: "/home/test", exists: async () => true },
    };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check).toMatchObject({
      status: "pass",
      recovery: "manual",
      details: { mode: "host", upstream: { source: "env", reachable: true } },
    });
    expect(JSON.stringify(check)).not.toContain("private-value");
  });

  test("host mode without an agent is degraded with remediation naming sshAgent.socket", async () => {
    // Given
    const input = { ...inputs(), globalConfig: { sshAgent: { sidecar: false } } };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check).toMatchObject({
      status: "warn",
      context: { state: "degraded" },
      details: { mode: "host", upstream: { source: "none", reachable: false } },
    });
    expect(check.solutions[0]?.description).toContain("sshAgent.socket");
    expect(check.solutions[0]?.description).toContain("SSH_AUTH_SOCK");
  });

  test("reports unreachable sidecar without exposing probe errors", async () => {
    // Given
    const input = {
      ...inputs(),
      probe: async () => {
        throw new Error("key material private-value");
      },
    };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check).toMatchObject({ status: "warn", details: { upstream: { reachable: false } } });
    expect(check.solutions[0]?.command).toBe("lando doctor --fix");
    expect(JSON.stringify(check)).not.toContain("private-value");
  });

  test("reports missing provider delivery as degraded even with a reachable agent", async () => {
    // Given
    const input = { ...inputs(), capabilities: {} };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check).toMatchObject({
      status: "warn",
      details: { delivery: "none", upstream: { reachable: true } },
    });
  });

  test("host fix never calls sidecar setup", async () => {
    // Given
    let calls = 0;
    const input = inputs();
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...input,
        globalConfig: { sshAgent: { sidecar: false } },
        fix: true,
        sshService: {
          ...input.sshService,
          setup: () =>
            Effect.sync(() => {
              calls++;
            }),
        },
      }),
    );
    // Then
    expect(calls).toBe(0);
    expect(check.context.fixOutcome).toBe("skipped-manual");
  });

  test("sidecar fix reports recovery only when the agent becomes reachable", async () => {
    // Given
    let ready = false;
    const input = inputs();
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...input,
        fix: true,
        sshService: {
          ...input.sshService,
          setup: () =>
            Effect.sync(() => {
              ready = true;
            }),
          getAgentSocket: () =>
            ready
              ? input.sshService.getAgentSocket(AppId.make("global"))
              : Effect.fail(new SshError({ sshId: "sidecar", message: "stopped" })),
        },
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, sidecarRegistry),
        Effect.provideService(GlobalAppService, globalAppForProvider(ProviderId.make("lando"))),
      ),
    );
    // Then
    expect(check).toMatchObject({
      status: "pass",
      context: { fixOutcome: "recovered", fixCommand: "ssh.setup" },
      details: { upstream: { reachable: true } },
    });
  });

  test("successful setup alone cannot mark an unreachable agent recovered", async () => {
    // Given
    const input = {
      ...inputs(),
      fix: true,
      probe: async () => {
        throw new Error("offline");
      },
    };
    // When
    const check = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(sshAgentPostureCheck(input));
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(RuntimeProviderRegistry, sidecarRegistry),
        Effect.provideService(GlobalAppService, globalAppForProvider(ProviderId.make("lando"))),
      ),
    );
    // Then
    expect(check.status).toBe("warn");
    expect(check.context.fixOutcome).toBe("failed");
    expect(check.context.fixError).toBe(
      "SSH agent forwarding remains degraded after setup. Last probe failure: offline",
    );
  });

  test.each([false, true])(
    "runtime-volume fix reports readiness detail when agent answers=%s",
    async (answers) => {
      // Given
      let started = false;
      let probes = 0;
      const input = inputs();
      const provider = {
        ...TestRuntimeProvider,
        id: ProviderId.make("lando"),
        inspect: () =>
          Effect.sync(() => ({
            app: AppId.make("global"),
            service: ServiceName.make("ssh-agent"),
            providerId: ProviderId.make("lando"),
            status: started ? "running" : "exited",
            publications: { status: "present" as const, bindings: [] },
          })),
        exec: () =>
          Effect.sync(() => ({ exitCode: ++probes < 3 || !answers ? 2 : 0, stdout: "", stderr: "" })),
      };
      // When
      const check = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sshAgentPostureCheck({
              ...input,
              fix: true,
              sshService: {
                ...input.sshService,
                setup: () =>
                  Effect.sync(() => {
                    started = true;
                  }),
                getAgentSocket: (appId) =>
                  Effect.succeed({ appId, socketPath: "/missing.sock", runtimeVolume: "agent-volume" }),
              },
            }),
          );
          yield* TestClock.adjust("30 seconds");
          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([provider.id]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
          Effect.provideService(GlobalAppService, globalAppForProvider(ProviderId.make("lando"))),
          Effect.provide(TestClock.layer()),
        ),
      );
      // Then
      expect(check).toMatchObject({
        status: answers ? "pass" : "warn",
        context: { fixOutcome: answers ? "recovered" : "failed" },
        details: { delivery: "runtime-volume", upstream: { reachable: answers } },
      });
      if (!answers)
        expect(check.context.fixError).toContain(
          "Last probe failure: SSH readiness shell probe exited with code 2",
        );
    },
  );

  test("sidecar fix reports the redacted setup failure cause", async () => {
    // Given an unreachable sidecar whose setup fails with a specific cause and secret.
    const input = inputs();
    const message = "SSH agent sidecar could not start: statfs /home/test/.ssh: no such file or directory";
    // When doctor attempts automatic repair.
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...input,
        fix: true,
        probe: async () => {
          throw new Error("offline");
        },
        sshService: {
          ...input.sshService,
          setup: () =>
            Effect.fail(
              new SshError({
                sshId: "sidecar",
                message: `${message} HTTP_PROXY_PASSWORD=super-secret`,
              }),
            ),
        },
      }),
    );
    // Then repair remains failed and exposes the actionable cause without credentials.
    expect(check.status).toBe("warn");
    expect(check.context).toMatchObject({ fixOutcome: "failed", fixCommand: "ssh.setup", fixExitCode: "1" });
    expect(check.context.fixError).toContain(message);
    expect(check.context.fixError).toContain("[redacted]");
    expect(check.context.fixError).not.toContain("super-secret");
  });

  test("sidecar fix masks a bare environment secret value in the setup failure", async () => {
    // Given a setup failure that echoes the value of a secret-named environment variable.
    const input = inputs();
    const secret = "env-only-sidecar-token-7f3a";
    // When doctor attempts automatic repair with that environment.
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        ...input,
        fix: true,
        env: { LANDO_TEST_API_TOKEN: secret },
        probe: async () => {
          throw new Error("offline");
        },
        sshService: {
          ...input.sshService,
          setup: () =>
            Effect.fail(new SshError({ sshId: "sidecar", message: `sidecar rejected credential ${secret}` })),
        },
      }),
    );
    // Then the reported repair error never carries the raw value.
    expect(check.context.fixError).toContain("sidecar rejected credential");
    expect(check.context.fixError).not.toContain(secret);
  });

  test("subsystem doctor reads global SSH config without requiring an app", async () => {
    // Given
    const input = inputs();
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      sshAgent: { sidecar: false, socket: "/missing" },
    });
    // When
    const report = await Effect.runPromise(
      subsystemDoctor({ sshAgent: { ...input, globalConfig: undefined } }).pipe(
        Effect.provideService(
          ConfigService,
          ConfigService.of({
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
        ),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );
    // Then
    expect(report.checks.find((check) => check.name === "ssh")?.details?.mode).toBe("host");
  });

  test("typed SSH details survive report encoding and NDJSON", async () => {
    // Given
    const check = await Effect.runPromise(sshAgentPostureCheck(inputs()));
    const report = {
      version: "test",
      provider: { checks: [] },
      subsystems: { checks: [check] },
      globalApp: { checks: [] },
      mcp: { checks: [] },
    };
    // When
    const encoded = Schema.encodeSync(DoctorReportSchema)(report);
    const ndjson = renderSubsystemDoctorResultAsNdjson(report.subsystems);
    // Then
    expect(encoded.subsystems.checks[0]?.details).toEqual(check.details);
    expect(JSON.parse(ndjson.split("\n")[0] ?? "{}").payload.details).toEqual(check.details);
  });

  test("sidecar posture key identifies the managed agent", async () => {
    // Given / When
    const check = await Effect.runPromise(sshAgentPostureCheck(inputs()));
    // Then
    expect(check.details?.mode).toBe("sidecar");
    expect(check.context.securityPosture).toBe("sidecar-managed-keys");
  });

  test("host posture key identifies host signatures", async () => {
    // Given
    const input = {
      ...inputs(),
      globalConfig: { sshAgent: { sidecar: false } },
      discovery: { home: "/home/test", exists: async () => true },
    };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check.details?.mode).toBe("host");
    expect(check.context.securityPosture).toBe("host-signatures");
  });

  test("win32 guest-bridge posture key identifies the unauthenticated loopback relay", async () => {
    // Given
    const input = {
      ...inputs(),
      platform: "win32",
      globalConfig: { sshAgent: { sidecar: false } },
      capabilities: { agentSocket: { delivery: "guest-bridge" as const } },
      discovery: { home: "/home/test", exists: async () => false },
      probe: async () => {
        throw new Error("offline");
      },
    };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check.details?.mode).toBe("host");
    expect(check.context.securityPosture).toBe("host-win32-loopback");
  });
});
import { literalLandofile } from "../_support/value-contracts.ts";
