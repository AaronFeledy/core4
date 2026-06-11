import { Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

export interface BunSelfSpawnerOptions {
  readonly cmd: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface BunSelfSpawner {
  readonly spawn: (options: BunSelfSpawnerOptions) => Promise<{ readonly exitCode: number }>;
}

export interface BunSelfRunOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly spawner?: BunSelfSpawner;
  readonly execPath?: string;
  readonly callerSubsystem?: string;
  readonly verb?: string;
}

export interface BunSelfRunResult {
  readonly exitCode: number;
}

export interface BunSelfXOptions extends BunSelfRunOptions {
  readonly spec: string;
}

export interface BunSelfInstallOptions extends Omit<BunSelfRunOptions, "argv" | "verb"> {}

export const BUN_SELF_REENTRY_ENV = "LANDO_DISALLOW_BUN_BE_BUN_REENTRY" as const;
export const BUN_BE_BUN_ENV = "BUN_BE_BUN" as const;

const isReentryBlocked = (env: NodeJS.ProcessEnv): boolean => {
  const value = env[BUN_SELF_REENTRY_ENV];
  return typeof value === "string" && value !== "" && value !== "0";
};

export const defaultBunSelfSpawner: BunSelfSpawner = {
  spawn: async ({ cmd, env, cwd }) => {
    const proc = Bun.spawn({
      cmd: [...cmd],
      env,
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    return { exitCode };
  },
};

/**
 * Build the child-process env for `bun install` / self-reentry.
 *
 * Pass-through by design: registry auth and other parent env values must
 * survive into the spawned Bun process; the inherited stdio path keeps Bun's
 * own UX intact.
 */
export const childEnv = (parentEnv: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) if (typeof v === "string") env[k] = v;
  env[BUN_BE_BUN_ENV] = "1";
  env[BUN_SELF_REENTRY_ENV] = "1";
  return env;
};

const publishBunSelfEvent = (event: Readonly<Record<string, unknown>>) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event as never).pipe(Effect.ignore) : Effect.void,
    ),
  );

export const bunSelfRun = (
  options: BunSelfRunOptions,
): Effect.Effect<BunSelfRunResult, NotImplementedError> =>
  Effect.gen(function* () {
    if (isReentryBlocked(process.env)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: "Recursive `lando bun` invocation detected — BunSelfRunner refuses to re-enter.",
          commandId: "meta:bun",
          remediation:
            "Use the embedded Bun's own help/scripting facilities; do not nest `lando bun` inside `lando bun run`.",
        }),
      );
    }
    const spawner = options.spawner ?? defaultBunSelfSpawner;
    const execPath = options.execPath ?? process.execPath;
    const cwd = options.cwd ?? process.cwd();
    const verb = options.verb ?? options.argv[0] ?? "run";
    const callerSubsystem = options.callerSubsystem ?? "cli:meta:bun";
    yield* publishBunSelfEvent({
      _tag: "pre-bun-self-exec",
      verb,
      callerSubsystem,
      argv: [...options.argv],
      cwd,
      mode: "embedded",
      timestamp: new Date().toISOString(),
    });
    const { exitCode } = yield* Effect.promise(() =>
      spawner.spawn({
        cmd: [execPath, ...options.argv],
        env: childEnv(process.env),
        cwd,
      }),
    );
    yield* publishBunSelfEvent({
      _tag: "post-bun-self-exec",
      verb,
      callerSubsystem,
      argv: [...options.argv],
      cwd,
      mode: "embedded",
      exitCode,
      timestamp: new Date().toISOString(),
    });
    return { exitCode };
  });

export const bunSelfX = (options: BunSelfXOptions): Effect.Effect<BunSelfRunResult, NotImplementedError> =>
  bunSelfRun({ ...options, argv: ["x", options.spec, ...options.argv] });

export const bunSelfInstall = (
  options: BunSelfInstallOptions = {},
): Effect.Effect<BunSelfRunResult, NotImplementedError> =>
  bunSelfRun({ ...options, argv: ["install"], verb: "install" });
