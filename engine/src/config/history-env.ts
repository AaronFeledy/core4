import { Effect } from "effect";

import {
  HISTORY_CLIENT_ENV_NAMES,
  HISTORY_CLIENT_FILES,
  HISTORY_MOUNT_TARGET,
  historyFilePath,
} from "@lando/sdk/schema";
import type { ExecTarget, RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";

export const containerHasHistoryMount = (runtime: ServiceRuntimeInfo | undefined): boolean =>
  runtime?.mountDestinations?.includes(HISTORY_MOUNT_TARGET) === true;

/** Shared exec/shell/tooling fallback: flag, then planned service user, then target. */
export const resolveHistoryExecUser = (
  explicit: string | undefined,
  serviceUser: string | undefined,
  targetUser: string | undefined,
): string | undefined => explicit ?? serviceUser ?? targetUser;

const resolvedValue = (
  name: string,
  serviceEnv: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>> | undefined,
): string | undefined => env?.[name] ?? serviceEnv?.[name];

const alreadySet = (
  name: string,
  serviceEnv: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>> | undefined,
): boolean => resolvedValue(name, serviceEnv, env) !== undefined;

/**
 * Exec-time histfile env for a TTY session. Never baked into container env.
 * Skips when the session is not a TTY, history is disabled, or the running
 * container lacks the history mount. Existing service (and explicit exec) env
 * wins per variable. MYSQL_HISTFILE and MARIADB_HISTFILE are coupled: if
 * MARIADB_HISTFILE is set, Lando injects neither; if only MYSQL_HISTFILE is
 * set, MARIADB_HISTFILE copies that value so the mariadb client does not land
 * on Lando's file.
 */
export const withHistoryExecEnv = (input: {
  readonly tty: boolean;
  readonly serviceName: string;
  readonly user?: string | undefined;
  readonly serviceEnv?: Readonly<Record<string, string>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly hasHistoryMount: boolean;
  readonly enabled?: boolean | undefined;
}): Record<string, string> | undefined => {
  if (!input.tty || input.enabled === false || !input.hasHistoryMount) {
    return input.env === undefined ? undefined : { ...input.env };
  }

  const inject: Record<string, string> = {};
  const mysqlUser = resolvedValue("MYSQL_HISTFILE", input.serviceEnv, input.env);
  const mariadbUser = resolvedValue("MARIADB_HISTFILE", input.serviceEnv, input.env);

  for (const name of HISTORY_CLIENT_ENV_NAMES) {
    if (name === "MYSQL_HISTFILE" || name === "MARIADB_HISTFILE") continue;
    if (alreadySet(name, input.serviceEnv, input.env)) continue;
    inject[name] = historyFilePath(input.serviceName, HISTORY_CLIENT_FILES[name], input.user);
  }

  if (mysqlUser === undefined && mariadbUser === undefined) {
    const path = historyFilePath(input.serviceName, HISTORY_CLIENT_FILES.MYSQL_HISTFILE, input.user);
    inject.MYSQL_HISTFILE = path;
    inject.MARIADB_HISTFILE = path;
  } else if (mysqlUser !== undefined && mariadbUser === undefined) {
    inject.MARIADB_HISTFILE = mysqlUser;
  }

  const merged = { ...inject, ...(input.env ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
};

export const mergeHistoryExecEnv = Effect.fnUntraced(function* (input: {
  readonly provider: RuntimeProviderShape;
  readonly target: ExecTarget;
  readonly serviceName: string;
  readonly user?: string | undefined;
  readonly serviceEnv?: Readonly<Record<string, string>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly tty: boolean;
  readonly enabled?: boolean | undefined;
}) {
  if (!input.tty || input.enabled === false) return input.env;
  const runtime = yield* input.provider
    .inspect(input.target)
    .pipe(Effect.catch(() => Effect.succeed<ServiceRuntimeInfo | undefined>(undefined)));
  return withHistoryExecEnv({
    tty: true,
    serviceName: input.serviceName,
    user: input.user ?? input.target.user,
    serviceEnv: input.serviceEnv,
    env: input.env,
    hasHistoryMount: containerHasHistoryMount(runtime),
    enabled: true,
  });
});
