import { homedir } from "node:os";
import { probeSshAgent } from "@lando/engine/subsystems/ssh-agent/agent-probe";
import {
  type HostAgentDiscoveryOptions,
  discoverHostSshAgent,
} from "@lando/engine/subsystems/ssh-agent/host-agent-discovery";
import { resolveSshAgentIntent } from "@lando/engine/subsystems/ssh/intent";
import { AppId, type GlobalConfig, type ProviderCapabilities } from "@lando/sdk/schema";
import {
  ConfigService,
  LandofileService,
  type ProcessRunner,
  RuntimeProviderRegistry,
  type SshService,
} from "@lando/sdk/services";
import { Effect, Either, Option } from "effect";
import { loadUserLandofile } from "../app-resolution";
import { gpgAgentPostureDetail } from "./doctor-gpg-agent";
import { type DoctorSubsystemCheck, SSH_SPEC, type SshAgentPostureDetails } from "./doctor-subsystem-checks";

type Details = typeof SshAgentPostureDetails.Type;

export interface SshAgentDoctorOptions {
  readonly globalConfig?: Pick<GlobalConfig, "sshAgent" | "gpgAgent"> | undefined;
  readonly gpgRunner?: Pick<ProcessRunner["Type"], "run">;
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly discovery?: Partial<Pick<HostAgentDiscoveryOptions, "home" | "exists" | "runGpgconf">>;
  readonly capabilities?: Pick<ProviderCapabilities, "agentSocket">;
  readonly probe?: typeof probeSshAgent;
}

export const sshAgentPostureCheck = (
  input: SshAgentDoctorOptions & { readonly sshService: SshService["Type"]; readonly fix?: boolean },
): Effect.Effect<DoctorSubsystemCheck> =>
  Effect.gen(function* () {
    const config = yield* Effect.serviceOption(ConfigService);
    const sshAgent =
      input.globalConfig === undefined && Option.isSome(config)
        ? yield* config.value.get("sshAgent").pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        : input.globalConfig?.sshAgent;
    const landofiles = yield* Effect.serviceOption(LandofileService);
    const landofile = Option.isSome(landofiles)
      ? yield* loadUserLandofile(landofiles.value).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      : undefined;
    const intent = resolveSshAgentIntent({
      landofile: landofile ?? {},
      globalConfig: sshAgent === undefined ? undefined : { sshAgent },
    });
    const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    const capabilities =
      input.capabilities ??
      (Option.isSome(registry)
        ? yield* registry.value.capabilities.pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        : undefined);
    const delivery = capabilities?.agentSocket?.delivery ?? "none";
    const probeAgent = (upstream: Parameters<typeof probeSshAgent>[0]) =>
      Effect.tryPromise({
        try: () => (input.probe ?? probeSshAgent)(upstream, { timeoutMs: 1_000 }),
        catch: (cause: unknown) => cause,
      });
    const inspect: Effect.Effect<Details["upstream"]> = Effect.gen(function* () {
      switch (intent.mode) {
        case "sidecar": {
          const socket = yield* input.sshService.getAgentSocket(AppId.make("global"));
          const upstream = { _tag: "unix" as const, path: socket.socketPath };
          const probed = yield* Effect.either(probeAgent(upstream));
          return {
            source: "sidecar" as const,
            reachable: probed._tag === "Right",
            ...(probed._tag === "Right" ? { identities: probed.right.identities } : {}),
          } satisfies Details["upstream"];
        }
        case "host": {
          const discovered = yield* discoverHostSshAgent({
            platform: input.platform ?? process.platform,
            env: input.env ?? process.env,
            home: input.discovery?.home ?? homedir(),
            ...(intent.socket === undefined ? {} : { explicitSocket: intent.socket }),
            ...(input.discovery?.exists === undefined ? {} : { exists: input.discovery.exists }),
            ...(input.discovery?.runGpgconf === undefined ? {} : { runGpgconf: input.discovery.runGpgconf }),
            gpgTimeoutMs: 1_000,
            probeTimeoutMs: 1_000,
            probe: probeAgent,
          });
          return {
            source: discovered.upstream.source,
            reachable: true,
            identities: discovered.identities,
          } satisfies Details["upstream"];
        }
        default:
          return intent.mode satisfies never;
      }
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          source: intent.mode === "sidecar" ? "sidecar" : "none",
          reachable: false,
        } satisfies Details["upstream"]),
      ),
    );
    let upstream = yield* inspect;
    const fixContext: Record<string, string> = {};
    if (input.fix && (!upstream.reachable || delivery === "none")) {
      switch (intent.mode) {
        case "host":
          fixContext.fixOutcome = "skipped-manual";
          break;
        case "sidecar": {
          const setup = yield* Effect.either(input.sshService.setup({ force: false }));
          if (Either.isRight(setup)) upstream = yield* inspect;
          const recovered = Either.isRight(setup) && upstream.reachable && delivery !== "none";
          fixContext.fixOutcome = recovered ? "recovered" : "failed";
          fixContext.fixCommand = "ssh.setup";
          fixContext.fixExitCode = recovered ? "0" : "1";
          if (!recovered) fixContext.fixError = "SSH agent forwarding remains degraded after setup.";
          break;
        }
        default:
          intent.mode satisfies never;
      }
    }
    const ready = upstream.reachable && delivery !== "none";
    const recovery = intent.mode === "sidecar" ? "automatic" : "manual";
    const securityPosture: "sidecar-managed-keys" | "host-signatures" | "host-win32-loopback" =
      intent.mode === "sidecar"
        ? "sidecar-managed-keys"
        : (input.platform ?? process.platform) === "win32" && delivery === "guest-bridge"
          ? "host-win32-loopback"
          : "host-signatures";
    const security = ((): string => {
      switch (securityPosture) {
        case "sidecar-managed-keys":
          return "The sidecar loads unencrypted keys from ~/.ssh into a Lando-managed agent that opted-in services can use.";
        case "host-signatures":
          return "Services that opt in can request signatures from your host agent and private keys stay on the host.";
        case "host-win32-loopback":
          return "Services that opt in can request signatures from your host agent and private keys stay on the host. The host relay listens on a loopback TCP port without a token, so any local account on that Windows host can use it while the app runs.";
        default:
          return securityPosture satisfies never;
      }
    })();
    const configuredGpg =
      input.globalConfig === undefined && Option.isSome(config)
        ? yield* config.value.get("gpgAgent").pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        : input.globalConfig?.gpgAgent;
    const gpg = yield* gpgAgentPostureDetail({
      landofile: landofile ?? {},
      ...(configuredGpg === undefined ? {} : { globalGpg: configuredGpg }),
      ...(input.gpgRunner === undefined ? {} : { runner: input.gpgRunner }),
      ...(input.discovery?.exists === undefined ? {} : { exists: input.discovery.exists }),
    });
    return {
      name: "ssh",
      status: ready ? "pass" : "warn",
      severity: ready ? "info" : "warn",
      recovery,
      context: {
        subsystem: "ssh",
        subsystemId: intent.mode === "sidecar" ? input.sshService.id : "host",
        ready: String(ready),
        state: ready ? "ready" : "degraded",
        mode: intent.mode,
        upstreamSource: upstream.source,
        upstreamReachable: String(upstream.reachable),
        ...(upstream.identities === undefined ? {} : { identities: String(upstream.identities) }),
        delivery,
        securityPosture,
        security,
        ...fixContext,
      },
      details: { mode: intent.mode, upstream, delivery, security, ...(gpg === undefined ? {} : { gpg }) },
      solutions: ready
        ? []
        : [
            {
              kind: input.fix ? "manual" : recovery,
              description:
                intent.mode === "host"
                  ? "Start your SSH agent and set sshAgent.socket or SSH_AUTH_SOCK to its socket path. Select a provider with agentSocket delivery; host forwarding fails closed when unavailable."
                  : `${input.fix ? SSH_SPEC.manualRemediation : SSH_SPEC.automaticRemediation} Select a provider with agentSocket delivery if delivery is none. Sidecar forwarding is best-effort.`,
              ...(intent.mode === "sidecar"
                ? { command: input.fix ? "lando setup" : "lando doctor --fix" }
                : {}),
            },
          ],
    };
  });
