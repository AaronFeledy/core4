import { Effect } from "effect";

import { AppId } from "@lando/sdk/schema";

import {
  ROUTE_FILE_PREFIX,
  ROUTE_FILE_SUFFIX,
  dynamicConfigDir,
  joinFor,
  routingStateFile,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { DEFAULT_AUTHORITY_PORTS, authorityPortsFrom, persistedAuthorities } from "./routing.ts";

const isConcurrentRemoval = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "FileNotFoundError";

export const persistedStatus = (dependencies: TraefikProxyDependencies) =>
  Effect.gen(function* () {
    const directory = dynamicConfigDir(dependencies.paths);
    const statePath = routingStateFile(dependencies.paths);
    if (!(yield* dependencies.fileSystem.exists(directory))) {
      return { state: "stopped" as const, authorities: [], configuredApps: [] };
    }

    const running = yield* dependencies.fileSystem.exists(statePath);
    const ports = running
      ? authorityPortsFrom((yield* dependencies.fileSystem.readText(statePath)).split("\n"))
      : DEFAULT_AUTHORITY_PORTS;
    const routeFiles = (yield* dependencies.fileSystem.readDir(directory)).filter(
      (file) => file.startsWith(ROUTE_FILE_PREFIX) && file.endsWith(ROUTE_FILE_SUFFIX),
    );
    const entries = yield* Effect.forEach(routeFiles, (file) =>
      dependencies.fileSystem.readText(joinFor(dependencies.paths)(directory, file)).pipe(
        Effect.map((content) => ({
          app: AppId.make(
            decodeURIComponent(file.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length)),
          ),
          authorities: persistedAuthorities(content, ports),
        })),
        Effect.catchAll((cause) =>
          isConcurrentRemoval(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
        ),
      ),
    );
    const presentEntries = entries.filter((entry) => entry !== undefined);
    return {
      state: running ? ("running" as const) : ("stopped" as const),
      authorities: presentEntries.flatMap((entry) => entry.authorities),
      configuredApps: presentEntries.map((entry) => entry.app),
    };
  });
