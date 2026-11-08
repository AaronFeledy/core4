import { readFile, readdir } from "node:fs/promises";

import { globalAppRootPath } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect } from "effect";

import { dynamicConfigDir, joinFor } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";
import { isOwnerLayoutRouteFile, isRouteFileName } from "./route-file-metadata.ts";

const CONTEXT_VALUE_MAX = 2_000;

const readOptional = <A>(read: () => Promise<A>): Effect.Effect<A | undefined> =>
  Effect.tryPromise({ try: read, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(cause),
    ),
    Effect.orDie,
  );

const legacyReport = (files: ReadonlyArray<string>, platform: ProxyPaths["platform"]): PluginDoctorReport => {
  let listed = "";
  let included = 0;
  for (const file of files) {
    const next = included === 0 ? file : `${listed}, ${file}`;
    if (next.length > CONTEXT_VALUE_MAX) break;
    listed = next;
    included++;
  }
  const truncated = included < files.length;
  return {
    name: "legacy-route-files",
    status: "warn",
    severity: "warn",
    runtimeStatus: "legacy-route-files",
    context: {
      proxyId: "traefik",
      legacyCount: String(files.length),
      files: listed,
      ...(truncated ? { truncated: "true" } : {}),
    },
    solutions: [
      {
        kind: "manual",
        description: truncated
          ? "Manually delete the listed legacy route files, then run `lando doctor` again to list the remaining files."
          : "Manually delete the legacy route files listed in this report.",
      },
      ...(platform === "win32"
        ? [
            {
              kind: "manual" as const,
              description:
                "After deleting the files, restart the global app so Traefik reloads its file provider.",
              command: "lando global:restart",
            },
          ]
        : []),
      {
        kind: "manual",
        description:
          "Then republish the routes you still need: run `lando start` in a user app, `lando global:start` for global services, or start the scratch app again with its scratch command.",
      },
    ],
  };
};

export const legacyRouteFilesCheck: PluginDoctorCheckContribution = {
  id: "legacy-route-files",
  run: Effect.fnUntraced(function* ({ userDataRoot, platform }) {
    if (userDataRoot === undefined) return [];
    const paths: ProxyPaths = { platform, globalAppRoot: globalAppRootPath(userDataRoot, platform) };
    const directory = dynamicConfigDir(paths);
    const names = yield* readOptional(() => readdir(directory));
    if (names === undefined) return [];
    const candidates = names.filter(isRouteFileName).toSorted();
    if (candidates.length === 0) return [];
    const legacy = yield* Effect.forEach(
      candidates,
      (name) => {
        const path = joinFor(paths)(directory, name);
        return readOptional(() => readFile(path, "utf8")).pipe(
          Effect.map((content) => {
            if (content === undefined) return undefined;
            return isOwnerLayoutRouteFile(name, content) ? undefined : name;
          }),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.map((items) => items.filter((name): name is string => name !== undefined)));
    if (legacy.length === 0) return [];
    return [
      legacyReport(
        legacy.map((file) => joinFor(paths)(directory, file)),
        platform,
      ),
    ];
  }),
};
