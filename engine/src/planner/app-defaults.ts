import { isAbsolute, relative } from "node:path";

import type { GlobalConfig, ServiceConfig } from "@lando/sdk/schema";
import type { SshAgentIntent } from "../subsystems/ssh/intent.ts";

type AppDefaultPaths = {
  readonly globalAppRoot: string;
  readonly scratchDir: string;
};

export type UserAppDefaults = {
  readonly environment?: NonNullable<GlobalConfig["serviceDefaults"]>["environment"];
  readonly labels?: NonNullable<GlobalConfig["serviceDefaults"]>["labels"];
};

export const cacheInput = (
  routerEnabled: boolean,
  scanner: GlobalConfig["scanner"],
  defaults: UserAppDefaults & {
    readonly defaultDomain: string;
    readonly sshAgentMode: SshAgentIntent["mode"];
    readonly gpgAgentForward?: boolean;
  },
) => ({
  routerEnabled,
  defaultDomain: defaults.defaultDomain,
  scanner: scanner ?? null,
  environment: defaults.environment ?? null,
  labels: defaults.labels ?? null,
  sshAgentMode: defaults.sshAgentMode,
  gpgAgentForward: defaults.gpgAgentForward ?? false,
});

const isPathWithin = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child))
  );
};

export const isExcludedFromUserAppDefaults = (
  appName: string,
  appRoot: string,
  paths: AppDefaultPaths | undefined,
): boolean =>
  appName === "global" ||
  (paths !== undefined && (appRoot === paths.globalAppRoot || isPathWithin(paths.scratchDir, appRoot)));

export const resolveUserAppDefaults = (
  appName: string,
  appRoot: string,
  paths: AppDefaultPaths | undefined,
  config: GlobalConfig | undefined,
): UserAppDefaults => {
  return isExcludedFromUserAppDefaults(appName, appRoot, paths)
    ? {}
    : {
        ...(config?.serviceDefaults?.environment === undefined
          ? {}
          : { environment: config.serviceDefaults.environment }),
        ...(config?.serviceDefaults?.labels === undefined ? {} : { labels: config.serviceDefaults.labels }),
      };
};

export const withUserAppDefaults = (input: {
  readonly service: ServiceConfig;
  readonly defaults: UserAppDefaults;
  readonly topLevelEnvironment: Readonly<Record<string, string>>;
  readonly serviceEnvironment: import("@lando/sdk/schema").Environment | undefined;
  readonly hasEnvFiles: boolean;
}): ServiceConfig => {
  const hasEnvironment = input.defaults.environment !== undefined;
  const hasLabels = input.defaults.labels !== undefined;
  if (!input.hasEnvFiles && !hasEnvironment && !hasLabels) return input.service;

  return {
    ...input.service,
    ...(input.hasEnvFiles || hasEnvironment
      ? {
          environment: {
            ...(input.defaults.environment ?? {}),
            ...input.topLevelEnvironment,
            ...(input.serviceEnvironment ?? input.service.environment ?? {}),
          },
        }
      : {}),
    ...(hasLabels ? { labels: { ...input.defaults.labels, ...(input.service.labels ?? {}) } } : {}),
  };
};
