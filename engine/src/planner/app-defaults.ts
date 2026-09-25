import { isAbsolute, relative } from "node:path";

import type { GlobalConfig, ServiceConfig } from "@lando/sdk/schema";
import type { SshAgentIntent } from "../subsystems/ssh/intent.ts";

type AppDefaultPaths = {
  readonly globalAppRoot: string;
  readonly scratchDir: string;
};

export type UserAppDefaults = Pick<GlobalConfig, "appEnv" | "appLabels">;

export const cacheInput = (
  routerEnabled: boolean,
  scanner: GlobalConfig["scanner"],
  defaults: UserAppDefaults & { readonly sshAgentMode: SshAgentIntent["mode"] },
) => ({
  routerEnabled,
  scanner: scanner ?? null,
  appEnv: defaults.appEnv ?? null,
  appLabels: defaults.appLabels ?? null,
  sshAgentMode: defaults.sshAgentMode,
});

const isPathWithin = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child))
  );
};

export const resolveUserAppDefaults = (
  appName: string,
  appRoot: string,
  paths: AppDefaultPaths | undefined,
  config: GlobalConfig | undefined,
): UserAppDefaults => {
  const excluded =
    appName === "global" ||
    (paths !== undefined && (appRoot === paths.globalAppRoot || isPathWithin(paths.scratchDir, appRoot)));
  return excluded
    ? { appEnv: undefined, appLabels: undefined }
    : { appEnv: config?.appEnv, appLabels: config?.appLabels };
};

export const withUserAppDefaults = (input: {
  readonly service: ServiceConfig;
  readonly defaults: UserAppDefaults;
  readonly topLevelEnvironment: Readonly<Record<string, string>>;
  readonly serviceEnvironment: Readonly<Record<string, string>> | undefined;
  readonly hasEnvFiles: boolean;
}): ServiceConfig => {
  const hasAppEnv = input.defaults.appEnv !== undefined;
  const hasAppLabels = input.defaults.appLabels !== undefined;
  if (!input.hasEnvFiles && !hasAppEnv && !hasAppLabels) return input.service;

  return {
    ...input.service,
    ...(input.hasEnvFiles || hasAppEnv
      ? {
          environment: {
            ...(input.defaults.appEnv ?? {}),
            ...input.topLevelEnvironment,
            ...(input.serviceEnvironment ?? input.service.environment ?? {}),
          },
        }
      : {}),
    ...(hasAppLabels ? { labels: { ...input.defaults.appLabels, ...(input.service.labels ?? {}) } } : {}),
  };
};
