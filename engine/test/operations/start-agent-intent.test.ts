import { expect, test } from "bun:test";
import {
  ConfigError,
  GpgAgentTransportError,
  LandofileParseError,
  SshAgentTransportError,
} from "@lando/sdk/errors";
import { AbsolutePath, GlobalConfig, type LandofileShape } from "@lando/sdk/schema";
import { ConfigService, LandofileService } from "@lando/sdk/services";
import { Effect, Layer, Result, Schema } from "effect";
import { type ResolvedAppTarget, userAppRef } from "../../src/landofile/app-resolution.ts";
import { resolveStartAgentIntent } from "../../src/operations/start-agent-intent.ts";
import { resolveStartGpgAgentIntent } from "../../src/operations/start-gpg-agent-intent.ts";
import { resolveStartSshAgentIntent } from "../../src/operations/start-ssh-agent-intent.ts";
import { gpgAgentPlanExtension, resolveGpgAgentIntent } from "../../src/subsystems/gpg-agent/intent.ts";
import { gpgAgentEligibleServices } from "../../src/subsystems/gpg-agent/overlay.ts";
import { sshAgentEligibleServices } from "../../src/subsystems/ssh-agent/overlay.ts";
import { resolveSshAgentIntent, sshAgentPlanExtension } from "../../src/subsystems/ssh/intent.ts";
import { plan } from "../subsystems/gpg-agent/fixture.ts";

const ssh = resolveStartAgentIntent({
  label: "SSH",
  error: SshAgentTransportError,
  eligibleServices: sshAgentEligibleServices,
  planExtension: sshAgentPlanExtension,
  fallbackLandofile: (extension) => ({ sshAgent: { sidecar: extension.mode !== "host" } }),
  resolveIntent: resolveSshAgentIntent,
});
const gpg = resolveStartAgentIntent({
  label: "GPG",
  error: GpgAgentTransportError,
  eligibleServices: gpgAgentEligibleServices,
  planExtension: gpgAgentPlanExtension,
  fallbackLandofile: (extension) => ({ gpgAgent: { forward: extension.forward } }),
  resolveIntent: resolveGpgAgentIntent,
});
type Intent = Effect.Success<ReturnType<typeof ssh>> | Effect.Success<ReturnType<typeof gpg>>;
type ResolveIntent = (
  target: ResolvedAppTarget,
) => Effect.Effect<Intent, SshAgentTransportError | GpgAgentTransportError>;
const cases: readonly {
  readonly label: "SSH" | "GPG";
  readonly resolve: ResolveIntent;
  readonly existing: ResolveIntent;
  readonly defaults: Intent;
  readonly configured: Intent;
  readonly fallback: Intent;
}[] = [
  {
    label: "SSH",
    resolve: ssh,
    existing: resolveStartSshAgentIntent,
    defaults: { mode: "sidecar" },
    configured: { mode: "host", socket: "/app/agent" },
    fallback: { mode: "host" },
  },
  {
    label: "GPG",
    resolve: gpg,
    existing: resolveStartGpgAgentIntent,
    defaults: { forward: false },
    configured: { forward: true, socket: "/app/agent" },
    fallback: { forward: true },
  },
];
const landofile: LandofileShape = {
  name: "agent",
  services: {},
  sshAgent: { sidecar: false, socket: "/app/agent" },
  gpgAgent: { forward: true, socket: "/app/agent" },
};
const globalConfig = Schema.decodeUnknownSync(GlobalConfig)({
  sshAgent: { sidecar: true, socket: "/global/agent" },
  gpgAgent: { forward: false, socket: "/global/agent" },
});
const eligiblePlan = {
  ...plan,
  root: AbsolutePath.make(process.cwd()),
  services: Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      {
        ...service,
        extensions: { "@lando/core/ssh-agent": { mode: "host" }, "@lando/core/gpg-agent": { forward: true } },
      },
    ]),
  ),
};
const target: ResolvedAppTarget = {
  plan: eligiblePlan,
  root: eligiblePlan.root,
  app: userAppRef(eligiblePlan),
};
const loadFailure = new LandofileParseError({
  message: "invalid",
  filePath: ".lando.yml",
  line: undefined,
  column: undefined,
});

for (const agent of cases) {
  test(`${agent.label} reloads an absent target Landofile before resolving intent`, async () => {
    // Given
    const calls: string[] = [];
    const layer = Layer.mergeAll(
      Layer.succeed(LandofileService, {
        discover: Effect.sync(() => {
          calls.push("load");
          return landofile;
        }),
      }),
      Layer.succeed(ConfigService, {
        load: Effect.sync(() => {
          calls.push("config");
          return globalConfig;
        }),
        get: (key) => Effect.succeed(globalConfig[key]),
      }),
    );
    // When
    const actual = await Effect.runPromise(agent.resolve(target).pipe(Effect.provide(layer)));
    // Then
    expect(actual).toEqual(agent.configured);
    expect(calls).toEqual(["load", "config"]);
    expect(actual).toEqual(await Effect.runPromise(agent.existing(target).pipe(Effect.provide(layer))));
  });

  test(`${agent.label} maps reload failures to its broker error`, async () => {
    // Given
    const layer = Layer.succeed(LandofileService, { discover: Effect.fail(loadFailure) });
    // When
    const result = await Effect.runPromise(agent.resolve(target).pipe(Effect.provide(layer), Effect.result));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: `${agent.label === "SSH" ? "Ssh" : "Gpg"}AgentTransportError`,
        stage: "broker",
        message: `Unable to resolve the current ${agent.label} agent configuration.`,
        remediation: "Fix the app Landofile and retry lando start.",
      });
  });

  test(`${agent.label} uses a supplied Landofile without reloading it`, async () => {
    // Given
    const layer = Layer.succeed(LandofileService, { discover: Effect.die("Unexpected reload") });
    // When
    const actual = await Effect.runPromise(
      agent.resolve({ ...target, landofile }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(actual).toEqual(agent.configured);
  });

  test(`${agent.label} maps global configuration failures to its broker error`, async () => {
    // Given
    const layer = Layer.succeed(ConfigService, {
      load: Effect.fail(new ConfigError({ message: "invalid" })),
      get: () => Effect.die("Unexpected get"),
    });
    // When
    const result = await Effect.runPromise(
      agent.resolve({ ...target, landofile }).pipe(Effect.provide(layer), Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        stage: "broker",
        message: `Unable to resolve the global ${agent.label} agent configuration.`,
        remediation: "Fix the global configuration and retry lando start.",
      });
  });

  test(`${agent.label} uses its plan extension when reload is unavailable`, async () => {
    // Given
    const extended = {
      ...target,
      plan: {
        ...eligiblePlan,
        extensions: { "@lando/core/ssh-agent": { mode: "host" }, "@lando/core/gpg-agent": { forward: true } },
      },
    };
    // When
    const actual = await Effect.runPromise(agent.resolve(extended));
    // Then
    expect(actual).toEqual(agent.fallback);
  });

  for (const kind of ["global", "ineligible"] as const) {
    test(`${agent.label} returns its default without loading configuration for ${kind} targets`, async () => {
      // Given
      const selected: ResolvedAppTarget =
        kind === "global"
          ? { ...target, app: { kind: "global", id: "global", root: target.root } }
          : { ...target, plan: { ...eligiblePlan, services: {} } };
      const layer = Layer.mergeAll(
        Layer.succeed(LandofileService, { discover: Effect.die("Unexpected Landofile load") }),
        Layer.succeed(ConfigService, {
          load: Effect.die("Unexpected config load"),
          get: () => Effect.die("Unexpected get"),
        }),
      );
      // When
      const actual = await Effect.runPromise(agent.resolve(selected).pipe(Effect.provide(layer)));
      // Then
      expect(actual).toEqual(agent.defaults);
      expect(actual).toEqual(await Effect.runPromise(agent.existing(selected).pipe(Effect.provide(layer))));
    });
  }
}
