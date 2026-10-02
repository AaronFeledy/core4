import {
  type MachineSshBridgeHost,
  makeMachineSshBridge,
} from "@lando/container-runtime/podman/machine-ssh-bridge";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AgentSocketBridgeInput, type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { PathsService, ProcessRunner } from "@lando/sdk/services";
import { Effect, Either, Option, Schema } from "effect";

const MachineList = Schema.parseJson(
  Schema.Array(
    Schema.Struct({
      Name: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
      Default: Schema.Boolean,
    }),
  ),
);

const bridgeFailure = (cause: unknown) =>
  new ProviderUnavailableError({
    providerId: "podman",
    operation: "agent-socket-bridge",
    message: "Could not resolve the default Podman machine for agent forwarding.",
    remediation: "Select and start a default Podman machine, then retry with `lando start`.",
    cause,
  });

export const resolveDefaultPodmanMachine = async (
  run: MachineSshBridgeHost["run"],
): Promise<string | undefined> => {
  const result = await run("podman", ["machine", "list", "--format", "json"]);
  if (result.exitCode !== 0) throw bridgeFailure(undefined);
  const machines = Schema.decodeUnknownEither(MachineList)(result.stdout);
  return Either.match(machines, {
    onLeft: (cause) => {
      throw bridgeFailure(cause);
    },
    onRight: (values) => values.find((machine) => machine.Default)?.Name,
  });
};

export const resolvePodmanAgentBridge = (options: {
  readonly platform: HostPlatform;
  readonly stateDir?: string;
  readonly agentBridgeHost?: MachineSshBridgeHost;
}) =>
  Effect.gen(function* () {
    const family = hostPlatformFamily(options.platform);
    if (family === "linux") return undefined;
    const runner = yield* Effect.serviceOption(ProcessRunner);
    const run =
      options.agentBridgeHost?.run ??
      Option.match(runner, {
        onNone: () => undefined,
        onSome: (service) => (cmd: string, args: readonly string[]) =>
          Effect.runPromise(service.run({ cmd, args, timeoutMs: 15_000 })),
      });
    if (run === undefined) return undefined;
    const machineName = yield* Effect.tryPromise({
      try: () => resolveDefaultPodmanMachine(run),
      catch: bridgeFailure,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (machineName === undefined) return undefined;
    const paths = yield* Effect.serviceOption(PathsService);
    const stateDir =
      options.stateDir ??
      Option.map(paths, (value) => value.pluginStateDir("@lando/provider-podman")).pipe(
        Option.getOrUndefined,
      );
    return {
      openAgentSocketBridge: (input: AgentSocketBridgeInput) => {
        if (stateDir === undefined)
          return Effect.fail(bridgeFailure("Provider state directory is unavailable."));
        const opened = makeMachineSshBridge({
          podmanBin: "podman",
          stateDir,
          machineName,
          providerId: "podman",
          sshBinary: family === "win32" ? "ssh.exe" : "ssh",
          ...(options.agentBridgeHost === undefined ? {} : { host: options.agentBridgeHost }),
        }).openAgentSocketBridge(input);
        return Option.match(runner, {
          onNone: () => opened,
          onSome: (service) => opened.pipe(Effect.provideService(ProcessRunner, service)),
        });
      },
    };
  });
