import { readFile, readdir } from "node:fs/promises";

import { globalAppRootPath } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect } from "effect";

import { recognizeLegacyRouteFile } from "./legacy-route-content.ts";
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

/** Keep whole paths within the existing evidence budget and the plugin array limit. */
const fileClass = (
  key: "generated" | "unrecognized",
  files: ReadonlyArray<string>,
): Record<string, string | ReadonlyArray<string>> => {
  if (files.length === 0) return {};
  const listed: string[] = [];
  let length = 0;
  for (const file of files) {
    const nextLength = length + file.length + (listed.length === 0 ? 0 : 2);
    if (nextLength > CONTEXT_VALUE_MAX || listed.length === 64) break;
    listed.push(file);
    length = nextLength;
  }
  const truncated = listed.length < files.length;
  return {
    [`${key}Count`]: String(files.length),
    [`${key}Files`]: listed,
    ...(truncated ? { [`${key}FilesTruncated`]: "true" } : {}),
  };
};

const REPUBLISH =
  "start the apps whose routes you still need: `lando start` in a user app, `lando global:start` for global services, or the scratch app's own command.";

const legacyReport = (
  generated: ReadonlyArray<string>,
  unrecognized: ReadonlyArray<string>,
  platform: ProxyPaths["platform"],
): PluginDoctorReport => ({
  name: "legacy-route-files",
  status: "warn",
  severity: unrecognized.length > 0 ? "warn" : "info",
  runtimeStatus: "legacy-route-files",
  context: {
    proxyId: "traefik",
    ...fileClass("generated", generated),
    ...fileClass("unrecognized", unrecognized),
  },
  solutions: [
    ...(generated.length > 0
      ? [
          {
            kind: "manual" as const,
            description:
              "These route files use the layout an older Lando wrote and keep publishing hostnames no app can withdraw. Lando removes them on the next routed app start; run `lando setup` to remove them now. Each app republishes its own routes when it starts.",
            command: "lando setup",
          },
        ]
      : []),
    ...(unrecognized.length > 0
      ? [
          {
            kind: "manual" as const,
            description: `Lando does not recognize these route files as its own, so it leaves them alone. Delete the ones you no longer need${platform === "win32" ? ", run `lando global:restart` so Traefik reloads its route configuration," : ""} then ${REPUBLISH}`,
            ...(platform === "win32" ? { command: "lando global:restart" } : {}),
          },
        ]
      : []),
  ],
});

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
            return isOwnerLayoutRouteFile(name, content)
              ? undefined
              : {
                  path,
                  generated: recognizeLegacyRouteFile(name, content) !== undefined,
                };
          }),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)));
    if (legacy.length === 0) return [];
    return [
      legacyReport(
        legacy.filter((file) => file.generated).map((file) => file.path),
        legacy.filter((file) => !file.generated).map((file) => file.path),
        platform,
      ),
    ];
  }),
};
