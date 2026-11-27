/**
 * The systemd user manager the managed runtime launches under on Linux.
 *
 * Without a running manager (`/run/user/<uid>/systemd/private`), the runtime cannot start in a
 * delegated scope, so containers share its cgroup and `deploy.resources` is withheld. Setup can
 * enable lingering, with its own consent, so a manager runs without a login session.
 */
import { userInfo } from "node:os";

import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

export interface UserAccount {
  readonly uid: number;
  readonly user: string;
}

/** What `systemctl show user@<uid>.service` reported; `unknown` is never proof of anything. */
export type UserManagerUnit =
  | {
      readonly _tag: "known";
      readonly loadState: string;
      readonly delegateControllers: ReadonlySet<string>;
    }
  | { readonly _tag: "unknown"; readonly reason: string };

export const REQUIRED_DELEGATED_CONTROLLERS = ["memory", "pids", "cpu"] as const;

export const parseUserManagerShow = (stdout: string): UserManagerUnit => {
  const values = new Map(
    stdout
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Za-z]+)=(.*)$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1] ?? "", (match[2] ?? "").trim()] as const),
  );
  const loadState = values.get("LoadState");
  const controllers = values.get("DelegateControllers");
  if (loadState === undefined || loadState === "") return { _tag: "unknown", reason: "no LoadState" };
  if (controllers === undefined) return { _tag: "unknown", reason: "no DelegateControllers" };
  return {
    _tag: "known",
    loadState,
    delegateControllers: new Set(controllers.split(/\s+/u).filter((name) => name.length > 0)),
  };
};

export const unitLacksDelegation = (unit: UserManagerUnit): boolean =>
  unit._tag === "known" &&
  unit.loadState === "loaded" &&
  REQUIRED_DELEGATED_CONTROLLERS.some((controller) => !unit.delegateControllers.has(controller));

export interface UserManagerHost {
  /** The account of this process's uid, never `$USER`. */
  readonly account: () => UserAccount | undefined;
  readonly managerRunning: (uid: number) => boolean;
  readonly showUnit: (uid: number) => Effect.Effect<UserManagerUnit>;
  /** Whether a host path exists, such as the system-wide delegation drop-in. */
  readonly pathExists: (path: string) => boolean;
}

const SHOW_TIMEOUT_MS = 10_000;

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

/** Passwd name of this process's uid; `$USER` only when that cannot be resolved. */
export const resolveProcessUserName = (env: ProcessEnvironment = process.env): string | undefined => {
  if (process.getuid?.() !== undefined) {
    try {
      const user = userInfo().username;
      if (user.length > 0) return user;
    } catch {
      // Non-POSIX lookup failure — fall through to `$USER`.
    }
  }
  const fallback = env.USER;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : undefined;
};

export const resolveProcessAccount = (env: ProcessEnvironment = process.env): UserAccount | undefined => {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const user = resolveProcessUserName(env);
  if (user === undefined) return undefined;
  return { uid, user };
};

export const makeSystemUserManagerHost = (
  exists: (path: string) => boolean,
  runner: Context.Service.Shape<typeof ProcessRunner> | undefined,
): UserManagerHost => ({
  account: () => resolveProcessAccount(),
  managerRunning: (uid) => exists(`/run/user/${uid}/systemd/private`),
  pathExists: exists,
  showUnit: (uid) =>
    runner === undefined
      ? Effect.succeed({ _tag: "unknown", reason: "no process runner" } as const)
      : runner
          .run({
            cmd: "systemctl",
            args: ["show", `user@${uid}.service`, "--property=LoadState", "--property=DelegateControllers"],
            timeoutMs: SHOW_TIMEOUT_MS,
          })
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseUserManagerShow(result.stdout)
                : ({ _tag: "unknown", reason: `systemctl exited ${result.exitCode}` } as const),
            ),
            Effect.catch((error) => Effect.succeed({ _tag: "unknown", reason: error.message } as const)),
          ),
});
