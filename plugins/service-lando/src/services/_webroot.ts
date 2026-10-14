import { posix } from "node:path";

import { Schema } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";
import { appMountTarget } from "./_volume-helpers.ts";

/** Resolve an authored document root without changing the authored service config. */
export const resolveWebroot = (
  typeLabel: string,
  authored: string | undefined,
  appMount?: ServiceConfig["appMount"],
): string => {
  if (appMount === false && !(authored ?? ".").startsWith("/")) {
    throw new Error(
      `${typeLabel} webroot "${authored ?? "."}" is relative to the app mount, but appMount is false. Set webroot to an absolute container path, or remove appMount: false.`,
    );
  }
  const mount = appMountTarget(appMount);
  const path = Schema.decodeUnknownSync(
    Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^[A-Za-z0-9._/-]+$/u, {
          message: `${typeLabel} webroot must be a path relative to the app mount (${mount}), such as public, or an absolute container path, using only letters, digits, '.', '_', '-', and '/'.`,
        }),
        Schema.makeFilter((value: string) => {
          const resolved = posix.resolve(mount, value);
          return (
            value.startsWith("/") ||
            resolved === mount ||
            resolved.startsWith(`${mount}/`) ||
            `${typeLabel} webroot ${value} leaves the app mount (${mount}); use an absolute container path instead.`
          );
        }),
      ),
    ),
  )(authored ?? ".");
  return posix.resolve(mount, path);
};
