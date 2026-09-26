import { describe, expect, test } from "bun:test";
import { LandofileParseError, SshError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { ConfigService, LandofileService } from "@lando/sdk/services";
import { makeTestSshService } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
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
      }).pipe(Effect.provideService(LandofileService, { discover: Effect.succeed(landofile) })),
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
      }).pipe(Effect.provideService(LandofileService, { discover: Effect.fail(failure) })),
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
    const check = await Effect.runPromise(sshAgentPostureCheck(input));
    // Then
    expect(check.status).toBe("warn");
    expect(check.context.fixOutcome).toBe("failed");
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
        Effect.provideService(ConfigService, {
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
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
