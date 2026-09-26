import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AgentSocketBridgeInput,
  type AgentSocketBridgeResult,
  type HostProxyBridgeInput,
  type HostProxyBridgeResult,
  PortNumber,
} from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Match, Option, Schema, type Scope } from "effect";

import {
  BridgeCommandError,
  type MachineSshBridgeHost,
  type MachineSshBridgeProcess,
  defaultHost,
} from "./machine-ssh-host.ts";

export type { MachineSshBridgeHost, MachineSshBridgeProcess } from "./machine-ssh-host.ts";

export interface MachineSshBridgeOptions {
  readonly podmanBin: string;
  readonly stateDir: string;
  readonly machineName: string;
  readonly sshBinary: "ssh" | "ssh.exe";
  readonly providerId: string;
  readonly host?: MachineSshBridgeHost;
}
interface BridgeTarget {
  readonly appId: string;
  readonly sessionId: string;
  readonly namespace: "host-proxy" | "agent-socket";
  readonly socketName: string;
  readonly local: string;
}
type BridgeEffect<Result> = Effect.Effect<Result, ProviderUnavailableError, Scope.Scope>;

const fingerprint = (value: string, length: number): string =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

const Machine = Schema.Struct({
  Name: Schema.String,
  State: Schema.Literal("running"),
  Created: Schema.NonEmptyString,
  SSHConfig: Schema.Struct({
    IdentityPath: Schema.NonEmptyString,
    Port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)),
    RemoteUsername: Schema.String.pipe(Schema.pattern(/^[a-z_][a-z0-9_-]*$/u)),
  }),
});

export const makeMachineSshBridge = (options: MachineSshBridgeOptions) => {
  const failure =
    (operation: "host-proxy-bridge" | "agent-socket-bridge") =>
    (cause: unknown): ProviderUnavailableError =>
      new ProviderUnavailableError({
        providerId: options.providerId,
        operation,
        message: "Could not connect the host socket to the Podman machine.",
        remediation: `Ensure OpenSSH Client (${options.sshBinary}) is installed, run \`lando setup --provider=${options.providerId}\`, and start the app again.`,
        cause,
      });
  const acquire = async (target: BridgeTarget, host: MachineSshBridgeHost, signal: AbortSignal) => {
    signal.throwIfAborted();
    const ssh = host.which(options.sshBinary);
    if (ssh === undefined)
      throw new BridgeCommandError(`OpenSSH client ${options.sshBinary} is unavailable.`);
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(target.socketName))
      throw new BridgeCommandError("Guest socket name must be a filename.");
    const inspected = await host.run(options.podmanBin, ["machine", "inspect", options.machineName]);
    if (inspected.exitCode !== 0) throw new BridgeCommandError("Podman machine inspect failed.");
    const machine = Schema.decodeUnknownSync(Schema.parseJson(Schema.Array(Machine)))(inspected.stdout)[0];
    if (machine === undefined || machine.Name !== options.machineName)
      throw new BridgeCommandError("The selected Podman machine is not running.");
    const knownHostsDir = join(options.stateDir, "host-proxy");
    await mkdir(knownHostsDir, { recursive: true });
    const generation = fingerprint(options.machineName + machine.Created, 20);
    const baseArgs = [
      "-F",
      options.sshBinary === "ssh.exe" ? "NUL" : "/dev/null",
      "-T",
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=accept-new",
      `-oUserKnownHostsFile=${join(knownHostsDir, `machine-known-hosts-${generation}`)}`,
      "-i",
      machine.SSHConfig.IdentityPath,
      "-p",
      String(machine.SSHConfig.Port),
    ];
    const destination = `${machine.SSHConfig.RemoteUsername}@127.0.0.1`;
    const remote = async (command: string): Promise<string> => {
      const result = await host.run(ssh, [...baseArgs, destination, command]);
      if (result.exitCode !== 0)
        throw new BridgeCommandError(`Podman machine SSH command failed (exit ${result.exitCode}).`);
      return result.stdout.trim();
    };
    const home = await remote('printf %s "$HOME"');
    if (!/^\/[a-zA-Z0-9/_.-]+$/u.test(home) || home.includes(".."))
      throw new BridgeCommandError("Podman machine home directory is not a safe absolute guest path.");
    const key = fingerprint(`${target.appId}/${target.sessionId}`, 32);
    const parent = `${home}/.local/share/lando/${target.namespace}`;
    const dir = `${parent}/${key}`;
    const socket = `${dir}/${target.socketName}`;
    if (Buffer.byteLength(socket) >= 104) throw new BridgeCommandError("Guest socket path is too long.");
    const mode = target.namespace === "agent-socket" ? "711" : "700";
    await remote(
      `mkdir -p -m ${mode} -- ${parent} && chmod ${mode} -- ${parent} && (mkdir -m ${mode} -- ${dir} || test -d ${dir}) && test ! -L ${dir} && chmod ${mode} -- ${dir}`,
    );
    const cleanup = () => remote(`rm -f -- ${socket}; rmdir -- ${dir}`);
    let child: MachineSshBridgeProcess | undefined;
    const abort = () => {
      if (child !== undefined) void child.close();
    };
    const release = async () => {
      signal.removeEventListener("abort", abort);
      try {
        if (child !== undefined) await child.close();
      } finally {
        await cleanup();
      }
    };
    try {
      await remote(`rm -f -- ${socket}`);
      signal.throwIfAborted();
      child = host.start(ssh, [
        ...baseArgs,
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        `${socket}:${target.local}`,
        destination,
        "printf 'LANDO_BRIDGE_READY\\n'; cat >/dev/null",
      ]);
      signal.addEventListener("abort", abort, { once: true });
      await child.waitReady();
      await remote(`test -S ${socket} && chmod 666 -- ${socket}`);
      signal.throwIfAborted();
    } catch (cause) {
      // Keep the forward failure as the primary cause even when cleanup fails too.
      await release().catch((releaseCause: unknown) => {
        throw new AggregateError(
          [cause, releaseCause],
          "SSH reverse forwarding failed and cleanup did not finish.",
        );
      });
      throw cause;
    }
    return { dir: AbsolutePath.make(dir), socket: AbsolutePath.make(socket), release };
  };
  const open = (operation: "host-proxy-bridge" | "agent-socket-bridge", target: () => BridgeTarget) =>
    Effect.gen(function* () {
      const processRunner = yield* Effect.serviceOption(ProcessRunner);
      const host: MachineSshBridgeHost = options.host ?? {
        ...defaultHost,
        run: async (command, args) => {
          if (Option.isNone(processRunner))
            throw new BridgeCommandError("ProcessRunner is unavailable for the Podman machine SSH bridge.");
          return Effect.runPromise(processRunner.value.run({ cmd: command, args, timeoutMs: 15_000 }));
        },
      };
      return yield* Effect.acquireRelease(
        Effect.tryPromise({ try: (signal) => acquire(target(), host, signal), catch: failure(operation) }),
        ({ release }) => Effect.tryPromise({ try: release, catch: failure(operation) }).pipe(Effect.orDie),
      );
    });
  return {
    openHostProxyBridge: (input: HostProxyBridgeInput): BridgeEffect<HostProxyBridgeResult> =>
      open("host-proxy-bridge", () => {
        const url = new URL(input.loopbackUrl);
        const port = Number(url.port);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !Schema.is(PortNumber)(port))
          throw new BridgeCommandError("The host-proxy worker must listen on a loopback TCP port.");
        return {
          appId: input.appId,
          sessionId: input.sessionId,
          namespace: "host-proxy",
          socketName: "host-proxy.sock",
          local: `127.0.0.1:${port}`,
        };
      }).pipe(Effect.map(({ socket }) => ({ socketPath: socket }))),
    openAgentSocketBridge: (input: AgentSocketBridgeInput): BridgeEffect<AgentSocketBridgeResult> =>
      open("agent-socket-bridge", () => {
        const local = Match.value(input.upstream).pipe(
          Match.tag("unix", ({ path }) => {
            if (!/^\/[^\r\n\0:]*$/u.test(path))
              throw new BridgeCommandError("Invalid absolute Unix agent socket path.");
            return path;
          }),
          Match.tag("loopback-tcp", ({ port, token }) => {
            if (token !== undefined)
              throw new BridgeCommandError("SSH forwarding requires a broker without a token handshake.");
            return `127.0.0.1:${port}`;
          }),
          Match.exhaustive,
        );
        return {
          appId: input.appId,
          sessionId: input.sessionId,
          namespace: "agent-socket",
          socketName: input.socketName,
          local,
        };
      }).pipe(Effect.map(({ dir }) => ({ _tag: "bind-directory", directory: dir }))),
  };
};
