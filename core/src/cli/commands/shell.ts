/**
 * `lando shell` — host-mode shell scoped to the current app or service-mode
 * shell inside a running service.
 *
 * Service mode runs `sh -l` in the requested service via provider execStream.
 * Host mode (`--host`) opens a host shell rooted at the app root.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { Chunk, Effect, Stream } from "effect";

import {
  type AppIdReservedError,
  type CapabilityError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  type LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
  ShellExecError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  type ExecTarget,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";
import { emitOptionalStderr, emitOptionalStdout } from "../renderer-boundary.ts";

export interface ShellAppOptions {
  readonly host?: boolean;
  readonly service?: string;
  readonly user?: string;
  readonly signal?: AbortSignal;
  readonly shellPath?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly io?: ShellIO;
  /** Test seam: inject a child-process launcher. */
  readonly launch?: ShellLauncher;
}

export interface ShellTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ShellIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly terminalSize?: () => ShellTerminalSize | undefined;
  readonly onResize?: (listener: () => void) => () => void;
}

const processShellIO: ShellIO = {
  writeStdout: () => {},
  writeStderr: () => {},
  stdin: process.stdin as AsyncIterable<Uint8Array>,
  terminalSize: () => {
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    return typeof columns === "number" && typeof rows === "number" ? { columns, rows } : undefined;
  },
  onResize: (listener) => {
    process.on("SIGWINCH", listener);
    return () => process.off("SIGWINCH", listener);
  },
};

export interface ShellLaunchSpec {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type ShellLauncher = (spec: ShellLaunchSpec) => Promise<{ readonly exitCode: number }>;

export interface ShellAppResult {
  readonly mode: "host" | "service";
  readonly app: string;
  readonly shell: string;
  readonly cwd: string;
  readonly service?: string;
  readonly exitCode: number;
}

export type ShellAppError =
  | AppIdReservedError
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ToolingExecError;

export type ShellAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

const defaultLauncher: ShellLauncher = (spec) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(spec.shell, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve({ exitCode: code });
        return;
      }
      resolve({ exitCode: typeof signal === "string" ? 1 : 0 });
    });
    child.once("error", (cause) => {
      reject(cause);
    });
  });

const filterStringEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
};

const availableServiceList = (services: AppPlan["services"]): string =>
  Object.values(services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const unknownServiceError = (requested: string, services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? `shell: service ${requested} is not in the app plan.`
        : `shell: service ${requested} is not in the app plan (available: ${list}).`,
    tool: "app:shell",
  });
};

const noPrimaryServiceError = (services: AppPlan["services"]): ToolingExecError => {
  const list = availableServiceList(services);
  return new ToolingExecError({
    message:
      list.length === 0
        ? "shell requires a service: the app has no services."
        : `shell requires a service: the app has no primary service (available: ${list}).`,
    tool: "app:shell",
  });
};

const resolveService = (
  serviceName: string | undefined,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ToolingExecError> => {
  if (serviceName === undefined || serviceName.length === 0) {
    const primary = Object.values(plan.services).find((service) => service.primary === true);
    return primary === undefined
      ? Effect.fail(noPrimaryServiceError(plan.services))
      : Effect.succeed(primary);
  }
  const match = Object.values(plan.services).find((service) => String(service.name) === serviceName);
  return match === undefined
    ? Effect.fail(unknownServiceError(serviceName, plan.services))
    : Effect.succeed(match);
};

const writeStdout = (io: ShellIO | undefined, chunk: string): Effect.Effect<void> =>
  io === undefined ? emitOptionalStdout(chunk) : Effect.sync(() => io.writeStdout(chunk));

const writeStderr = (io: ShellIO | undefined, chunk: string): Effect.Effect<void> =>
  io === undefined ? emitOptionalStderr(chunk) : Effect.sync(() => io.writeStderr(chunk));

const resizeStream = (io: ShellIO | undefined): Stream.Stream<ShellTerminalSize> => {
  if (io?.onResize === undefined || io.terminalSize === undefined) return Stream.empty;
  const onResize = io.onResize;
  return Stream.async<ShellTerminalSize>((emit) => {
    const listener = () => {
      const size = io.terminalSize?.();
      if (size !== undefined) emit(Effect.succeed(Chunk.of(size)));
    };
    return Effect.sync(onResize(listener));
  });
};

const currentTerminalSize = (io: ShellIO | undefined): ShellTerminalSize | undefined => io?.terminalSize?.();

export const shellApp = (
  options: ShellAppOptions = {},
): Effect.Effect<ShellAppResult, ShellAppError, ShellAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    const shell = options.shellPath ?? process.env.SHELL ?? "/bin/sh";
    if (!options.host) {
      const io = options.io ?? processShellIO;
      const service = yield* resolveService(options.service, plan);
      const provider = yield* registry.select(plan);
      const target: ExecTarget = {
        app: plan.id,
        service: service.name,
        plan,
        ...(options.user === undefined ? {} : { user: options.user }),
      };
      const terminalSize = currentTerminalSize(io);
      const spec: CommandSpec = {
        command: options.args?.length === 0 || options.args === undefined ? ["sh", "-l"] : options.args,
        stdin: "inherit",
        ...(io.stdin === undefined ? {} : { stdinStream: io.stdin }),
        tty: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(terminalSize === undefined ? {} : { terminalSize }),
        terminalResize: resizeStream(io),
      };
      let exitCode = 0;
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      yield* Effect.scoped(
        provider.execStream(target, spec).pipe(
          Stream.runForEach((chunk) => {
            if ("exitCode" in chunk) {
              exitCode = chunk.exitCode;
              return Effect.void;
            }
            const decoder = chunk.kind === "stdout" ? stdoutDecoder : stderrDecoder;
            const text = decoder.decode(chunk.chunk, { stream: true });
            return chunk.kind === "stdout" ? writeStdout(options.io, text) : writeStderr(options.io, text);
          }),
        ),
      );
      yield* Effect.all([
        writeStdout(options.io, stdoutDecoder.decode()),
        writeStderr(options.io, stderrDecoder.decode()),
      ]);
      return {
        mode: "service" as const,
        app: plan.name,
        service: String(service.name),
        shell: "sh",
        cwd: options.cwd ?? "/app",
        exitCode,
      };
    }

    const cwd = options.cwd ?? String(plan.root);
    const env: Record<string, string> = {
      ...filterStringEnv(process.env),
      ...(options.env ?? {}),
      LANDO: "1",
      LANDO_APP_NAME: plan.name,
      LANDO_APP_ROOT: String(plan.root),
    };

    const launch = options.launch ?? defaultLauncher;
    const launched = yield* Effect.tryPromise({
      try: () => launch({ shell, args: options.args ?? [], cwd, env }),
      catch: (cause) =>
        new ShellExecError({
          message:
            cause instanceof Error
              ? `Failed to launch host shell ${shell}: ${cause.message}`
              : `Failed to launch host shell ${shell}.`,
          command: [shell, ...(options.args ?? [])].join(" "),
          cwd,
          cause,
        }),
    });

    return {
      mode: "host" as const,
      app: plan.name,
      shell,
      cwd,
      exitCode: launched.exitCode,
    };
  });

export const renderShellAppResult = (result: ShellAppResult): string | undefined => {
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  return undefined;
};
