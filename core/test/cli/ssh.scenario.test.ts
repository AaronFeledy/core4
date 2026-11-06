import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { sshSpec } from "../../src/cli/command-specs/app/ssh.ts";
import { SESSION_NO_HISTORY_ENV } from "../../src/cli/service-login-shell.ts";
import { resolveTopLevelAliases } from "../../src/cli/spec/command-spec.ts";
import { environmentResolverLayer, literalLandofile } from "../_support/value-contracts.ts";
import { emptyConfigServiceLayer } from "./agent-env-test-config.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd = repoRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("lando ssh — provider-exec TTY command behavior", () => {
  test.each([
    { noHistory: false, serviceEnv: {}, hostIo: undefined, format: undefined },
    { noHistory: true, serviceEnv: {}, hostIo: undefined, format: undefined },
    {
      noHistory: true,
      serviceEnv: { HISTFILE: "/home/node/history", PSQL_HISTORY: "/home/node/psql" },
      hostIo: undefined,
      format: undefined,
    },
    { noHistory: true, serviceEnv: { HISTFILE: "/home/node/history" }, hostIo: "cli", format: "json" },
    { noHistory: true, serviceEnv: { HISTFILE: "/home/node/history" }, hostIo: "cli", format: undefined },
  ])(
    "applies session history policy through provider exec %j",
    async ({ noHistory, serviceEnv, hostIo, format }) => {
      const providerId = ProviderId.make("lando");
      const metadata = {
        resolvedAt: DateTime.makeUnsafe("2026-05-18T00:00:00Z"),
        source: "ssh.scenario.test",
        runtime: 4 as const,
      };
      const service = {
        name: ServiceName.make("appserver"),
        type: "node",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref" as const, ref: "node:22-alpine" },
        environment: serviceEnv,
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      };
      const plan: CurrentExecutableAppPlan = {
        valueModel: 1,
        id: AppId.make("ssh-scenario"),
        name: "ssh-scenario",
        slug: "ssh-scenario",
        root: AbsolutePath.make("/tmp/ssh-scenario"),
        provider: providerId,
        services: { [service.name]: service },
        routes: [],
        stores: [],
        fileSync: [],
        metadata,
        extensions: {},
      };
      const calls: Array<Readonly<Record<string, string>> | undefined> = [];
      const provider = {
        ...TestRuntimeProvider,
        execStream: (
          _target: Parameters<typeof TestRuntimeProvider.execStream>[0],
          command: Parameters<typeof TestRuntimeProvider.execStream>[1],
        ) => {
          calls.push(command.env);
          return Stream.make({ exitCode: 0 });
        },
      };
      const layer = Layer.mergeAll(
        environmentResolverLayer(),
        emptyConfigServiceLayer,
        Layer.succeed(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed(literalLandofile({ name: plan.name }, plan.root)) }),
        ),
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([providerId]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ),
      );

      await Effect.runPromise(
        sshSpec
          .run({
            flags: {
              service: "appserver",
              ...(noHistory ? { "no-history": true } : {}),
              ...(format === undefined ? {} : { format }),
            },
            ...(hostIo === undefined ? {} : { hostIo }),
            argv: [],
          })
          .pipe(Effect.provide(layer)),
      );

      expect(calls).toHaveLength(1);
      if (noHistory) expect(calls[0]).toMatchObject(SESSION_NO_HISTORY_ENV);
      else
        for (const key of Object.keys(SESSION_NO_HISTORY_ENV)) expect(calls[0] ?? {}).not.toHaveProperty(key);
    },
  );

  test("registers `ssh` and `app:ssh` as a top-level alias and native id", () => {
    expect(resolveTopLevelAliases(resolveBuiltInCommand("app:ssh")?.spec ?? sshSpec)).toContain("ssh");
    expect(resolveTopLevelAliases(sshSpec)).toContain("ssh");
  });

  test("`--subsystem` fails with a structured NotImplementedError (defer)", async () => {
    const result = await runCli(["ssh", "--subsystem=sftp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("subsystem");
    expect(result.stderr).toContain("not supported");
    expect(result.stderr).not.toMatch(/\bAlpha\b/);
    expect(result.stderr).not.toMatch(/\bBeta\b/);
  });

  test("`--sidecar` fails with a structured NotImplementedError (defer)", async () => {
    const result = await runCli(["ssh", "--sidecar"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("sidecar");
    expect(result.stderr).toContain("not supported");
    expect(result.stderr).not.toMatch(/\bAlpha\b/);
    expect(result.stderr).not.toMatch(/\bBeta\b/);
  });

  test("flag descriptions are phase-neutral current-state wording", () => {
    const flags = JSON.stringify(sshSpec.flags);
    expect(flags).toContain("not supported");
    expect(flags).not.toMatch(/\bAlpha\b/);
    expect(flags).not.toMatch(/\bBeta\b/);
  });
});
