import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type HostProxyBridgeInput, type HostProxyBridgeResult } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, type Scope } from "effect";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostProxyBridgeProcess {
  readonly waitReady: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface HostProxyBridgeHost {
  readonly which: (name: string) => string | undefined;
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<CommandResult>;
  readonly start: (command: string, args: ReadonlyArray<string>) => HostProxyBridgeProcess;
}

export interface WindowsHostProxyBridgeOptions {
  readonly podmanBin: string;
  readonly stateDir: string;
  readonly machineName: string;
  readonly host?: HostProxyBridgeHost;
}

const failure = (cause: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "host-proxy-bridge",
    message: "Could not connect the Windows host-proxy worker to the managed Podman machine.",
    remediation:
      "Ensure Windows OpenSSH Client is installed, run `lando setup --provider=lando`, and start the app again.",
    cause,
  });

const defaultHost: Omit<HostProxyBridgeHost, "run"> = {
  which: (name) => Bun.which(name) ?? undefined,
  start: (command, args) => {
    const child = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    let stderr = "";
    let closePromise: Promise<void> | undefined;
    void (async () => {
      for await (const chunk of child.stderr) {
        stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4096);
      }
    })();
    return {
      waitReady: async () => {
        const reader = child.stdout.getReader();
        const timeout = setTimeout(() => child.kill(), 15_000);
        try {
          let output = "";
          while (output.length < 1024) {
            const next = await reader.read();
            if (next.done) throw new Error(`SSH reverse forwarding exited before readiness: ${stderr}`);
            output += new TextDecoder().decode(next.value);
            if (output.includes("LANDO_BRIDGE_READY\n")) return;
          }
          throw new Error("SSH reverse forwarding did not report readiness.");
        } finally {
          clearTimeout(timeout);
          reader.releaseLock();
        }
      },
      close: () => {
        closePromise ??= (async () => {
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 3_000);
          try {
            await child.exited;
          } finally {
            clearTimeout(timeout);
          }
        })();
        return closePromise;
      },
    };
  },
};

const machineSshConfig = (value: string, expectedName: string) => {
  const decoded: unknown = JSON.parse(value);
  const machine = Array.isArray(decoded) ? decoded[0] : undefined;
  if (
    typeof machine !== "object" ||
    machine === null ||
    machine.Name !== expectedName ||
    machine.State !== "running"
  ) {
    throw new Error("The Lando-owned Podman machine is not running.");
  }
  if (typeof machine.Created !== "string" || machine.Created.length === 0) {
    throw new Error("Podman machine creation metadata is missing.");
  }
  const ssh: unknown = machine.SSHConfig;
  if (typeof ssh !== "object" || ssh === null) throw new Error("Podman machine SSH metadata is missing.");
  const config = ssh as Record<string, unknown>;
  if (
    typeof config.IdentityPath !== "string" ||
    config.IdentityPath.length === 0 ||
    typeof config.Port !== "number" ||
    !Number.isSafeInteger(config.Port) ||
    config.Port < 1 ||
    config.Port > 65535 ||
    typeof config.RemoteUsername !== "string" ||
    !/^[a-z_][a-z0-9_-]*$/u.test(config.RemoteUsername)
  ) {
    throw new Error("Podman machine SSH metadata is invalid.");
  }
  return {
    identityPath: config.IdentityPath,
    port: config.Port,
    username: config.RemoteUsername,
    created: machine.Created,
  };
};

const loopbackPort = (url: string): number => {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("The host-proxy worker must listen on a Windows loopback TCP port.");
  return port;
};

const guestPath = (home: string, appId: string, sessionId: string) => {
  if (!/^\/[a-zA-Z0-9/_.-]+$/u.test(home) || home.includes("..")) {
    throw new Error("Podman machine home directory is not a safe absolute guest path.");
  }
  const key = createHash("sha256").update(appId).update("/").update(sessionId).digest("hex").slice(0, 32);
  const parent = `${home}/.local/share/lando/host-proxy`;
  const dir = `${parent}/${key}`;
  const socket = `${dir}/host-proxy.sock`;
  if (Buffer.byteLength(socket) >= 104) throw new Error("Guest host-proxy socket path is too long.");
  return { parent, dir, socket };
};

const remote = async (
  host: HostProxyBridgeHost,
  ssh: string,
  baseArgs: ReadonlyArray<string>,
  command: string,
): Promise<string> => {
  const result = await host.run(ssh, [...baseArgs, command]);
  if (result.exitCode !== 0) {
    throw new Error(`Podman machine SSH command failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

const acquireBridge = async (
  options: WindowsHostProxyBridgeOptions,
  input: HostProxyBridgeInput,
  host: HostProxyBridgeHost,
  signal: AbortSignal,
): Promise<{ readonly result: HostProxyBridgeResult; readonly release: () => Promise<void> }> => {
  if (signal.aborted) throw new Error("Host-proxy bridge startup was cancelled.");
  const ssh = host.which("ssh.exe");
  if (ssh === undefined) throw new Error("Windows OpenSSH client ssh.exe is unavailable.");
  const port = loopbackPort(input.loopbackUrl);
  const inspected = await host.run(options.podmanBin, ["machine", "inspect", options.machineName]);
  if (inspected.exitCode !== 0) throw new Error(`Podman machine inspect failed: ${inspected.stderr.trim()}`);
  const machine = machineSshConfig(inspected.stdout, options.machineName);
  const knownHostsDir = join(options.stateDir, "host-proxy");
  await mkdir(knownHostsDir, { recursive: true });
  const generation = createHash("sha256")
    .update(options.machineName)
    .update(machine.created)
    .digest("hex")
    .slice(0, 20);
  const knownHosts = join(knownHostsDir, `machine-known-hosts-${generation}`);
  const baseArgs = [
    "-F",
    "NUL",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-i",
    machine.identityPath,
    "-p",
    String(machine.port),
    `${machine.username}@127.0.0.1`,
  ];
  const home = await remote(host, ssh, baseArgs, 'printf %s "$HOME"');
  const path = guestPath(home, String(input.appId), input.sessionId);
  await remote(
    host,
    ssh,
    baseArgs,
    `mkdir -p -m 700 -- ${path.parent} && chmod 700 -- ${path.parent} && mkdir -m 700 -- ${path.dir}`,
  );
  const cleanup = async (): Promise<void> => {
    await remote(
      host,
      ssh,
      baseArgs,
      `if [ -S ${path.socket} ]; then rm -- ${path.socket}; fi; rmdir -- ${path.dir}`,
    ).catch(() => undefined);
  };
  const args = [
    ...baseArgs.slice(0, -1),
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `${path.socket}:127.0.0.1:${port}`,
    baseArgs[baseArgs.length - 1] ?? "",
    "printf 'LANDO_BRIDGE_READY\\n'; cat >/dev/null",
  ];
  let process: HostProxyBridgeProcess;
  try {
    if (signal.aborted) throw new Error("Host-proxy bridge startup was cancelled.");
    process = host.start(ssh, args);
  } catch (cause) {
    await cleanup();
    throw cause;
  }
  const abort = (): void => {
    void process.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await process.waitReady();
    await remote(host, ssh, baseArgs, `test -S ${path.socket} && chmod 666 -- ${path.socket}`);
  } catch (cause) {
    signal.removeEventListener("abort", abort);
    await process.close().catch(() => undefined);
    await cleanup();
    throw cause;
  }
  return {
    result: { socketPath: AbsolutePath.make(path.socket) },
    release: async () => {
      signal.removeEventListener("abort", abort);
      try {
        await process.close();
      } finally {
        await cleanup();
      }
    },
  };
};

export const makeWindowsHostProxyBridge =
  (options: WindowsHostProxyBridgeOptions) =>
  (
    input: HostProxyBridgeInput,
  ): Effect.Effect<HostProxyBridgeResult, ProviderUnavailableError, Scope.Scope> =>
    Effect.gen(function* () {
      const processRunner = yield* Effect.serviceOption(ProcessRunner);
      const host: HostProxyBridgeHost = options.host ?? {
        ...defaultHost,
        run: async (command, args) => {
          if (processRunner._tag === "None")
            throw new Error("ProcessRunner is unavailable for the Podman machine SSH bridge.");
          return Effect.runPromise(processRunner.value.run({ cmd: command, args, timeoutMs: 15_000 }));
        },
      };
      return yield* Effect.acquireRelease(
        Effect.tryPromise({ try: (signal) => acquireBridge(options, input, host, signal), catch: failure }),
        ({ release }) => Effect.promise(release),
      ).pipe(Effect.map(({ result }) => result));
    });
