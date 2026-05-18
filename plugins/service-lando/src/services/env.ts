import { basename } from "node:path";

import type { ServiceTypeHostFacts, ServiceTypePlanInput } from "@lando/sdk/services";

const RESERVED_PREFIX = "LANDO" as const;

export type HostEnvFacts = ServiceTypeHostFacts;

export interface BuildLandoEnvOptions {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly appName: string;
  readonly appKind?: "user" | "global" | "scratch" | undefined;
  readonly appPaths?:
    | {
        readonly appRoot: string;
        readonly projectMount: string;
      }
    | undefined;
  readonly webroot?: string | undefined;
  readonly host?: HostEnvFacts | undefined;
  readonly extraDefaults?: Readonly<Record<string, string>> | undefined;
  readonly userEnv?: Readonly<Record<string, string>> | undefined;
}

const isReservedKey = (key: string): boolean =>
  key === RESERVED_PREFIX || key.startsWith(`${RESERVED_PREFIX}_`);

export const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const appNameFor = (input: ServiceTypePlanInput): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

export const validateUserEnv = (serviceName: string, userEnv: Readonly<Record<string, string>>): void => {
  const reserved = Object.keys(userEnv).filter((key) => isReservedKey(key));
  if (reserved.length > 0) {
    throw new Error(
      `User environment cannot override reserved LANDO_* keys (spec §6.9): ${reserved.join(", ")}. ` +
        `Remove these from services.${serviceName}.environment; plugins use LANDO_PLUGIN_<NAME>_* instead.`,
    );
  }
};

export const buildLandoEnv = (opts: BuildLandoEnvOptions): Record<string, string> => {
  const userEnv = opts.userEnv ?? {};
  validateUserEnv(opts.serviceName, userEnv);

  const env: Record<string, string> = { ...(opts.extraDefaults ?? {}), ...userEnv };
  env.LANDO = "ON";
  env.LANDO_APP_NAME = opts.appName;
  env.LANDO_APP_KIND = opts.appKind ?? "user";
  env.LANDO_PROJECT = slug(opts.appName);
  env.LANDO_SERVICE_API = "4";
  env.LANDO_SERVICE_NAME = opts.serviceName;
  env.LANDO_SERVICE_TYPE = opts.serviceType;

  if (opts.appPaths !== undefined) {
    env.LANDO_APP_ROOT = opts.appPaths.appRoot;
    env.LANDO_PROJECT_MOUNT = opts.appPaths.projectMount;
  }
  if (opts.webroot !== undefined) {
    env.LANDO_WEBROOT = opts.webroot;
  }
  if (opts.host !== undefined) {
    env.LANDO_HOST_OS = opts.host.os;
    env.LANDO_HOST_USER = opts.host.user;
    env.LANDO_HOST_UID = opts.host.uid;
    env.LANDO_HOST_GID = opts.host.gid;
    env.LANDO_HOST_HOME = opts.host.home;
  }

  return env;
};
