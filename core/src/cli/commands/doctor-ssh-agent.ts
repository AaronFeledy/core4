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
  FileSystem,
  LandofileService,
  ProcessRunner,
  RuntimeProviderRegistry,
  type SshService,
} from "@lando/sdk/services";
import { Effect, Either, Option } from "effect";
import { loadUserLandofile } from "../app-resolution";
import { type DoctorSubsystemCheck, SSH_SPEC, type SshAgentPostureDetails } from "./doctor-subsystem-checks";

type Details = typeof SshAgentPostureDetails.Type;

export interface SshAgentDoctorOptions {
  readonly globalConfig?: Pick<GlobalConfig, "sshAgent"> | undefined;
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
    const fs = yield* Effect.serviceOption(FileSystem);
    const runner = yield* Effect.serviceOption(ProcessRunner);
    const readUpstream = Effect.gen(function* () {
      switch (intent.mode) {
        case "sidecar": {
          const socket = yield* input.sshService.getAgentSocket(AppId.make("global"));
          return { source: "sidecar" as const, upstream: { _tag: "unix" as const, path: socket.socketPath } };
        }
        case "host": {
          const upstream = yield* discoverHostSshAgent({
            platform: input.platform ?? process.platform,
            env: input.env ?? process.env,
            home: input.discovery?.home ?? homedir(),
            ...(intent.socket === undefined ? {} : { explicitSocket: intent.socket }),
            exists:
              input.discovery?.exists ??
              ((path) =>
                Option.isSome(fs) ? Effect.runPromise(fs.value.exists(path)) : Promise.resolve(false)),
            runGpgconf:
              input.discovery?.runGpgconf ??
              (() =>
                Option.isSome(runner)
                  ? Effect.runPromise(
                      runner.value
                        .run({ cmd: "gpgconf", args: ["--list-dirs", "agent-ssh-socket"], timeoutMs: 1_000 })
                        .pipe(
                          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)),
                          Effect.catchAll(() => Effect.succeed(undefined)),
                        ),
                    )
                  : Promise.resolve(undefined)),
          });
          return { source: upstream.source, upstream };
        }
        default:
          return intent.mode satisfies never;
      }
    });
    const inspect: Effect.Effect<Details["upstream"]> = Effect.gen(function* () {
      const discovered = yield* Effect.either(readUpstream);
      if (Either.isLeft(discovered))
        return {
          source: intent.mode === "sidecar" ? "sidecar" : "none",
          reachable: false,
        } satisfies Details["upstream"];
      const result = yield* Effect.either(
        Effect.tryPromise(() =>
          (input.probe ?? probeSshAgent)(discovered.right.upstream, { timeoutMs: 1_000 }),
        ),
      );
      return {
        source: discovered.right.source,
        reachable: Either.isRight(result),
        ...(Either.isRight(result) ? { identities: result.right.identities } : {}),
      } satisfies Details["upstream"];
    });
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
    const security =
      "Services on apps that opt in can request signatures from this agent; private keys stay on the host.";
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
        security,
        ...fixContext,
      },
      details: { mode: intent.mode, upstream, delivery, security },
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
