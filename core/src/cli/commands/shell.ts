/**
 * `lando shell` — host shell at the app root by default, or a service shell with `--service`.
 *
 * Service mode runs `sh -l` in the requested service via provider execStream.
 * Host mode uses `ShellRunner` for interactive or non-interactive execution on the host.
 */
import { Chunk, DateTime, Effect, Stream } from "effect";

import {
  type AppIdReservedError,
  type CapabilityError,
  type ConfigError,
  type DeprecatedSurfaceError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  type LandofileNotFoundError,
  type LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  type LandofileValidationError,
  type LandofileVersionConstraintError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
  type ShellExecError,
  ShellRequiresTtyError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  type ConfigService,
  DeprecationService,
  type ExecTarget,
  LandofileService,
  type ProviderError,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";

import { resolveAgentEnvForwardAllowlist } from "../../config/agent-env-policy.ts";
import { withAgentContextEnv } from "../../config/agent-env.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import { quoteShellPath } from "../../services/shell-quote.ts";
import { loadUserLandofile } from "../app-resolution.ts";
import { emitOptionalStderr, emitOptionalStdout } from "../renderer-boundary.ts";

export interface ShellAppOptions {
  readonly host?: boolean;
  readonly service?: string;
  readonly noHistory?: boolean;
  readonly noInteractive?: boolean;
  readonly user?: string;
  readonly signal?: AbortSignal;
  readonly shellPath?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly io?: ShellIO;
  readonly isInteractive?: () => boolean;
  readonly historyFile?: string;
}

export interface ShellTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ShellIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly stdinIsTTY?: () => boolean;
  readonly stdinIsRaw?: () => boolean;
  readonly stdinIsPaused?: () => boolean;
  readonly setStdinRawMode?: (raw: boolean) => void;
  readonly resumeStdin?: () => void;
  readonly pauseStdin?: () => void;
  readonly terminalSize?: () => ShellTerminalSize | undefined;
  readonly onResize?: (listener: () => void) => () => void;
}

const processShellIO: ShellIO = {
  writeStdout: () => {},
  writeStderr: () => {},
  stdin: process.stdin as AsyncIterable<Uint8Array>,
  stdinIsTTY: () => process.stdin.isTTY === true,
  stdinIsRaw: () => process.stdin.isRaw === true,
  stdinIsPaused: () => process.stdin.isPaused(),
  setStdinRawMode: (raw) => process.stdin.setRawMode(raw),
  resumeStdin: () => {
    process.stdin.resume();
  },
  pauseStdin: () => {
    process.stdin.pause();
  },
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
  | ConfigError
  | DeprecatedSurfaceError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ShellRequiresTtyError
  | ToolingExecError;

export type ShellAppServices =
  | AppPlanner
  | ConfigService
  | LandofileService
  | RuntimeProviderRegistry
  | ShellRunner;

const HOST_FLAG_DEPRECATION_ID = "app:shell --host";

const recordHostFlagDeprecation = (enabled: boolean): Effect.Effect<void, DeprecatedSurfaceError> => {
  if (!enabled) return Effect.void;
  return Effect.serviceOption(DeprecationService).pipe(
    Effect.flatMap((deprecations) => {
      if (deprecations._tag === "None") return Effect.void;
      return deprecations.value.lookup("flag", HOST_FLAG_DEPRECATION_ID).pipe(
        Effect.flatMap((notice) =>
          notice._tag === "None"
            ? Effect.void
            : deprecations.value.use({
                kind: "flag",
                id: HOST_FLAG_DEPRECATION_ID,
                notice: notice.value,
                timestamp: DateTime.unsafeMake(new Date().toISOString()),
              }),
        ),
      );
    }),
  );
};

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

const withInteractiveStdinRawMode = <A, E, R>(
  io: ShellIO,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (io.stdin === undefined || io.stdinIsTTY?.() !== true || io.setStdinRawMode === undefined) {
        return () => {};
      }
      const wasRaw = io.stdinIsRaw?.() === true;
      const wasPaused = io.stdinIsPaused?.() === true;
      io.setStdinRawMode(true);
      io.resumeStdin?.();
      return () => {
        io.setStdinRawMode?.(wasRaw);
        if (wasPaused) io.pauseStdin?.();
      };
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  );

export const shellApp = (
  options: ShellAppOptions = {},
): Effect.Effect<ShellAppResult, ShellAppError, ShellAppServices> =>
  Effect.gen(function* () {
    yield* recordHostFlagDeprecation(options.host === true);

    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    const shell = options.shellPath ?? process.env.SHELL ?? "/bin/sh";
    const useServiceMode = options.service !== undefined && options.service.length > 0;
    if (useServiceMode) {
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
      const allowlist = yield* resolveAgentEnvForwardAllowlist(landofile.agentEnv, process.env);
      const serviceEnv = withAgentContextEnv(options.env, process.env, {
        allowlist,
        lowerThanEnv: service.environment,
      });
      const spec: CommandSpec = {
        command: options.args?.length === 0 || options.args === undefined ? ["sh", "-l"] : options.args,
        stdin: "inherit",
        ...(io.stdin === undefined ? {} : { stdinStream: io.stdin }),
        tty: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(serviceEnv === undefined ? {} : { env: serviceEnv }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(terminalSize === undefined ? {} : { terminalSize }),
        terminalResize: resizeStream(io),
      };
      let exitCode = 0;
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      yield* withInteractiveStdinRawMode(
        io,
        Effect.scoped(
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

    const shellRunner = yield* ShellRunner;
    const interactive =
      options.isInteractive?.() ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (options.noInteractive !== true && !interactive) {
      return yield* Effect.fail(
        new ShellRequiresTtyError({
          message: "lando shell requires an interactive terminal (TTY).",
          remediation:
            "Re-run with `lando shell --no-interactive` to execute the host shell without a TTY, or run a command non-interactively with `app:exec --interactive --tty -- <command>`.",
        }),
      );
    }

    const cwd = options.cwd ?? String(plan.root);
    const env: Record<string, string> = {
      ...filterStringEnv(process.env),
      ...(options.env ?? {}),
      LANDO: "1",
      LANDO_APP_NAME: plan.name,
      LANDO_APP_ROOT: String(plan.root),
    };

    let historyFile: string | undefined;
    if (options.noHistory === true) {
      env.HISTFILE = "/dev/null";
      env.HISTSIZE = "0";
      env.HISTFILESIZE = "0";
    } else {
      historyFile = options.historyFile ?? makeLandoPaths().shellHistoryFile(plan.name, String(plan.root));
    }

    if (options.noInteractive === true) {
      const command = [shell, ...(options.args ?? [])].map(quoteShellPath).join(" ");
      const result = yield* shellRunner.exec(command, { cwd, env }).pipe(
        Effect.catchTag("ShellExecError", (error) => {
          if (typeof error.exitCode === "number") {
            return Effect.succeed({
              exitCode: error.exitCode,
              stdout: error.stdout ?? "",
              stderr: error.stderr ?? "",
            });
          }
          return Effect.fail(error);
        }),
      );
      yield* Effect.all([emitOptionalStdout(result.stdout), emitOptionalStderr(result.stderr)]);
      return {
        mode: "host" as const,
        app: plan.name,
        shell,
        cwd,
        exitCode: result.exitCode,
      };
    }

    const launched = yield* shellRunner.interactive({
      shell,
      args: options.args ?? [],
      cwd,
      env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(historyFile === undefined ? {} : { historyFile }),
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
