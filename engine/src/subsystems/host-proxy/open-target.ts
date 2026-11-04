import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { HostProxyOpenUrlSchemeError } from "@lando/sdk/errors";
import type { HostProxyRequest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { type HostProxyOpenerError, openHostTarget, revealHostPath } from "../../services/host-opener.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";

export type HostProxyOpenRequest = Extract<HostProxyRequest, { readonly _tag: "openUrl" | "openPath" }>;

export class HostProxyOpenPathError extends Schema.TaggedError<HostProxyOpenPathError>()(
  "HostProxyOpenPathError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export type HostProxyOpenError = HostProxyOpenUrlSchemeError | HostProxyOpenPathError | HostProxyOpenerError;
export type HostProxyOpenExecutor<R = never> = (
  request: HostProxyOpenRequest,
  mount: HostProxyMountInfo,
) => Effect.Effect<void, HostProxyOpenError, R>;

export const DEFAULT_OPEN_SCHEMES = [
  "http",
  "https",
  "mailto",
  "tel",
  "vscode",
  "vscode-insiders",
  "cursor",
  "phpstorm",
  "idea",
  "webstorm",
  "goland",
  "pycharm",
  "rubymine",
  "clion",
  "fleet",
  "zed",
] as const;

const pathFailure = () =>
  new HostProxyOpenPathError({
    message: "The requested path is not an existing path inside the app mount.",
    remediation:
      "Reveal an existing file or directory inside the container's app mount; symlinks must stay inside that mount.",
  });

const contained = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return (
    rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)
  );
};

export const openHostProxyTarget = Effect.fn("HostProxy.openTarget")(function* (
  request: HostProxyOpenRequest,
  mount: HostProxyMountInfo,
  allowedSchemes: readonly string[] = [],
) {
  switch (request._tag) {
    case "openUrl": {
      const url = yield* Effect.try({
        try: () => new URL(request.url),
        catch: () =>
          new HostProxyOpenUrlSchemeError({
            message: "The requested URL is invalid.",
            remediation: "Use an absolute URL with an allowed scheme.",
          }),
      });
      const scheme = url.protocol.slice(0, -1).toLowerCase();
      if (
        scheme === "file" ||
        ![...DEFAULT_OPEN_SCHEMES, ...allowedSchemes].some((allowed) => allowed.toLowerCase() === scheme)
      ) {
        return yield* Effect.fail(
          new HostProxyOpenUrlSchemeError({
            message: "The requested URL scheme is not allowed.",
            scheme,
            remediation:
              scheme === "file"
                ? "Reveal app files by path, not file: URLs."
                : `Allow this scheme with: lando config set hostProxy.allowedSchemes '["${scheme}"]' --type=json`,
          }),
        );
      }
      yield* openHostTarget(request.url);
      return;
    }
    case "openPath": {
      const containerRoot = posix.resolve(mount.containerRoot);
      const path = posix.normalize(request.path);
      if (
        !posix.isAbsolute(path) ||
        (path !== containerRoot && !path.startsWith(`${containerRoot === "/" ? "" : containerRoot}/`))
      ) {
        return yield* Effect.fail(pathFailure());
      }
      const hostPath = resolve(mount.hostRoot, ...posix.relative(containerRoot, path).split("/"));
      if (!contained(resolve(mount.hostRoot), hostPath)) return yield* Effect.fail(pathFailure());
      const [root, target] = yield* Effect.tryPromise({
        try: () => Promise.all([realpath(mount.hostRoot), realpath(hostPath)]),
        catch: pathFailure,
      });
      if (!contained(root, target)) return yield* Effect.fail(pathFailure());
      const info = yield* Effect.tryPromise({ try: () => stat(target), catch: pathFailure });
      yield* revealHostPath(target, info.isDirectory());
      return;
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
});
