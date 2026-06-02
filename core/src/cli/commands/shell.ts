/**
 * `lando shell` — host-mode shell scoped to the current app.
 *
 * Default (no `--service`): spawn a host shell rooted at the app root with
 * `LANDO_APP_NAME` / `LANDO_APP_ROOT` injected into the child env. Stdio is
 * inherited so the user gets a real TTY.
 * `--service <name>` is not implemented yet and fails with `NotImplementedError`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { Effect } from "effect";

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
  NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
  ShellExecError,
} from "@lando/sdk/errors";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";

export interface ShellAppOptions {
  /**
   * When set, fails with `NotImplementedError`.
   */
  readonly service?: string;
  readonly shellPath?: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Test seam: inject a child-process launcher. */
  readonly launch?: ShellLauncher;
}

export interface ShellLaunchSpec {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type ShellLauncher = (spec: ShellLaunchSpec) => Promise<{ readonly exitCode: number }>;

export interface ShellAppResult {
  readonly mode: "host";
  readonly app: string;
  readonly shell: string;
  readonly cwd: string;
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
  | ProviderUnavailableError
  | ShellExecError;

export type ShellAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

const SERVICE_SHELL_DEFERRED = new NotImplementedError({
  message:
    "Service-targeted `lando shell --service <name>` is deferred to Beta. Use `lando exec --service <name> -- <command>` or `lando ssh --service <name>` for in-service execution in Alpha.",
  commandId: "app:shell",
  specSection: "spec/08-cli-and-tooling.md",
  remediation:
    "Drop the --service flag for a host shell scoped to the app root, or use `lando ssh --service <name>` for an interactive provider-exec shell inside the service.",
});

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

export const shellApp = (
  options: ShellAppOptions = {},
): Effect.Effect<ShellAppResult, ShellAppError, ShellAppServices> =>
  Effect.gen(function* () {
    if (options.service !== undefined && options.service.length > 0) {
      return yield* Effect.fail(SERVICE_SHELL_DEFERRED);
    }

    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);

    const shell = options.shellPath ?? process.env.SHELL ?? "/bin/sh";
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
