import { resolve } from "node:path";

import { Effect } from "effect";

import {
  SOCKET_PROXY_UNIT_PATHS,
  classifySocketProxyArtifacts,
  socketProxyContentDigest,
  socketProxyOwnerRoot,
} from "./socket-proxy-helper.ts";
import { POLKIT_RULE_PATH } from "./socket-proxy-units.ts";

export interface HostPathAccess {
  readonly userDataRoot: string;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly readText: (path: string) => Effect.Effect<string, unknown>;
  readonly realpath?: (path: string) => Effect.Effect<string, unknown>;
}

const canonicalSocketProxyRoot = (access: HostPathAccess): Effect.Effect<string> =>
  access.realpath === undefined
    ? Effect.succeed(resolve(access.userDataRoot))
    : access
        .realpath(access.userDataRoot)
        .pipe(Effect.catch(() => Effect.succeed(resolve(access.userDataRoot))));

export const inspectSocketProxy = Effect.fnUntraced(function* (access: HostPathAccess) {
  const currentRoot = yield* canonicalSocketProxyRoot(access);
  const paths = [...SOCKET_PROXY_UNIT_PATHS, POLKIT_RULE_PATH];
  const contents = yield* Effect.forEach(paths, (path) =>
    access
      .exists(path)
      .pipe(
        Effect.flatMap((exists) =>
          exists
            ? access.readText(path).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : Effect.succeed(null),
        ),
      ),
  );
  const units = contents.slice(0, SOCKET_PROXY_UNIT_PATHS.length);
  const classified =
    contents[SOCKET_PROXY_UNIT_PATHS.length] === undefined && units.some((text) => typeof text === "string")
      ? units
      : contents;
  const roots = [
    ...new Set(
      classified.flatMap((content) => {
        if (content === null || content === undefined) return [];
        const owner = socketProxyOwnerRoot(content);
        return owner === undefined ? [] : [owner];
      }),
    ),
  ];
  const existingRoots = yield* Effect.filter(roots, (root) => access.exists(root));
  const digests: Record<string, string | null> = {};
  paths.forEach((path, index) => {
    const text = contents[index];
    digests[path] = text === null ? null : text === undefined ? "unknown" : socketProxyContentDigest(text);
  });
  return {
    ownership: classifySocketProxyArtifacts(classified, currentRoot, existingRoots),
    digests,
    currentRoot,
  };
});

export const classifySocketProxy = (access: HostPathAccess) =>
  inspectSocketProxy(access).pipe(Effect.map((inspection) => inspection.ownership));
