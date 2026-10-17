import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileParseError, SshError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  GlobalConfig,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { ConfigService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
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
        Effect.provideService(LandofileService, LandofileService.of({ discover: Effect.succeed(landofile) })),
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

  test("host doctor surfaces unavailable reason and socket path", async () => {
    // Given an explicit host socket that does not exist.
    const input = {
      ...inputs(),
      globalConfig: { sshAgent: { sidecar: false, socket: "/missing-agent.sock" } },
    };
    // When
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then reason and path survive the doctor catch.
    expect(check).toMatchObject({
      status: "warn",
      context: { reason: "socket-missing", socketPath: "/missing-agent.sock" },
      details: {
        mode: "host",
        upstream: {
          source: "none",
          reachable: false,
          reason: "socket-missing",
          socketPath: "/missing-agent.sock",
        },
      },
    });
  });

  test("host doctor mentions a dangling SSH_AUTH_SOCK when another agent is picked", async () => {
    // Given a dangling env socket and a live 1Password agent.
    const root = await mkdtemp(join(tmpdir(), "doctor-ssh-dangling-"));
    const dangling = join(root, "gone.sock");
    const password = join(root, ".1password", "agent.sock");
    await mkdir(join(root, ".1password"));
    await symlink(join(root, "absent"), dangling);
    const server = createServer((socket) =>
      socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(password, resolve);
    });
    try {
      // When doctor inspects host mode.
      const check = await Effect.runPromise(
        sshAgentPostureCheck({
          ...inputs(),
          globalConfig: { sshAgent: { sidecar: false } },
          env: { SSH_AUTH_SOCK: dangling },
          discovery: { home: root },
        }),
      );
      // Then the selected agent is reported with a note about the dangling env socket.
      expect(check).toMatchObject({
        status: "pass",
        severity: "info",
        context: { danglingEnvSocket: dangling },
        details: {
          mode: "host",
          upstream: { source: "1password", reachable: true, danglingEnvSocket: dangling },
        },
      });
      expect(check.context.note).toContain("no longer exists");
      expect(check.context.note).toContain("1Password");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host doctor dangling env without another agent names the reconnect fix", async () => {
    // Given a dangling SSH_AUTH_SOCK and no other host agent.
    const root = await mkdtemp(join(tmpdir(), "doctor-ssh-dangling-fix-"));
    const dangling = join(root, "gone.sock");
    await symlink(join(root, "absent"), dangling);
    try {
      // When doctor inspects host mode.
      const check = await Effect.runPromise(
        sshAgentPostureCheck({
          ...inputs(),
          globalConfig: { sshAgent: { sidecar: false } },
          env: { SSH_AUTH_SOCK: dangling },
          discovery: { home: root },
        }),
      );
      // Then the reconnect remediation is the host fix.
      expect(check).toMatchObject({
        status: "warn",
        details: {
          mode: "host",
          upstream: { reachable: false, reason: "env-socket-dangling", socketPath: dangling },
        },
      });
      expect(check.solutions[0]?.description).toContain("Open a new terminal");
      expect(check.solutions[0]?.description).toContain("no longer exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      }),
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
      }).pipe(Effect.provide(TestClock.layer())),
    );
    // Then
    expect(check.status).toBe("warn");
    expect(check.context.fixOutcome).toBe("failed");
    expect(check.context.fixError).toBe("SSH agent forwarding remains degraded after setup.");
  });

  test("runtime-volume fix waits for the agent after setup before reporting recovered", async () => {
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
        })),
      exec: () => Effect.sync(() => ({ exitCode: ++probes < 3 ? 2 : 0, stdout: "", stderr: "" })),
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
        yield* TestClock.adjust("2 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([provider.id]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
        Effect.provide(TestClock.layer()),
      ),
    );
    // Then
    expect(check).toMatchObject({
      status: "pass",
      context: { fixOutcome: "recovered" },
      details: { delivery: "runtime-volume", upstream: { reachable: true } },
    });
  });

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
