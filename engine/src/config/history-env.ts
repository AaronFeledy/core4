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

const alreadySet = (
  name: string,
  serviceEnv: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>> | undefined,
): boolean => serviceEnv?.[name] !== undefined || env?.[name] !== undefined;

/**
 * Exec-time histfile env for a TTY session. Never baked into container env.
 * Skips when the session is not a TTY or the running container lacks the
 * history mount. Existing service (and explicit exec) env wins per variable.
 * Injecting MYSQL_HISTFILE unsets MARIADB_HISTFILE first unless that name is
 * already present, then MARIADB_HISTFILE is set to the same file when eligible.
 */
export const withHistoryExecEnv = (input: {
  readonly tty: boolean;
  readonly serviceName: string;
  readonly serviceEnv?: Readonly<Record<string, string>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly hasHistoryMount: boolean;
}): Record<string, string> | undefined => {
  if (!input.tty || !input.hasHistoryMount) {
    return input.env === undefined ? undefined : { ...input.env };
  }

  const inject: Record<string, string> = {};
  for (const name of HISTORY_CLIENT_ENV_NAMES) {
    const path = historyFilePath(input.serviceName, HISTORY_CLIENT_FILES[name]);
    if (name === "MYSQL_HISTFILE" && !alreadySet("MYSQL_HISTFILE", input.serviceEnv, input.env)) {
      if (!alreadySet("MARIADB_HISTFILE", input.serviceEnv, input.env)) {
        inject.MARIADB_HISTFILE = "";
      }
      inject.MYSQL_HISTFILE = path;
      continue;
    }
    if (alreadySet(name, input.serviceEnv, input.env)) continue;
    inject[name] = path;
  }

  const merged = { ...inject, ...(input.env ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
};

export const mergeHistoryExecEnv = Effect.fnUntraced(function* (input: {
  readonly provider: RuntimeProviderShape;
  readonly target: ExecTarget;
  readonly serviceName: string;
  readonly serviceEnv?: Readonly<Record<string, string>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly tty: boolean;
}) {
  if (!input.tty) return input.env;
  const runtime = yield* input.provider
    .inspect(input.target)
    .pipe(Effect.catch(() => Effect.succeed<ServiceRuntimeInfo | undefined>(undefined)));
  return withHistoryExecEnv({
    tty: true,
    serviceName: input.serviceName,
    serviceEnv: input.serviceEnv,
    env: input.env,
    hasHistoryMount: containerHasHistoryMount(runtime),
  });
});
