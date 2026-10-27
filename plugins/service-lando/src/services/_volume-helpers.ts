import { homedir } from "node:os";
import { isAbsolute, posix, resolve as resolvePath, win32 } from "node:path";
import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";

const DRIVE_LETTER_PREFIX = /^[A-Za-z]:[\\/]/;

export const canonicalTarget = (target: string): string => posix.resolve("/", target);

export const appMountTarget = (appMount: ServiceConfig["appMount"]): PortablePath =>
  PortablePath.make(canonicalTarget(typeof appMount === "object" ? appMount.target : "/app"));

export const isAppRelativeSource = (source: string): boolean =>
  !source.startsWith("~") && !isAbsolute(source) && !win32.isAbsolute(source) && !/^[A-Za-z]:/u.test(source);

export const resolveBindSource = (source: string, appRoot: string): string => {
  if (DRIVE_LETTER_PREFIX.test(source)) return source;
  const expanded =
    source === "~" ? homedir() : source.startsWith("~/") ? homedir() + source.slice(1) : source;
  if (isAbsolute(expanded) || win32.isAbsolute(expanded)) return expanded;
  if (DRIVE_LETTER_PREFIX.test(appRoot) || appRoot.startsWith("\\\\"))
    return win32.resolve(appRoot, expanded);
  return resolvePath(appRoot, expanded);
};

export const addServerConfigMount = (
  ctx: ServiceFeatureContext,
  target: Parameters<ServiceFeatureContext["addMount"]>[0]["target"],
): boolean => {
  const server = ctx.normalizedConfig.config?.server;
  if (server === undefined || server.length === 0) return false;
  ctx.addMount({
    type: "bind",
    source: resolveBindSource(server, ctx.appRoot),
    target,
    readOnly: true,
    ...(isAppRelativeSource(server) ? { relativeTo: "app" as const } : {}),
  });
  return true;
};
