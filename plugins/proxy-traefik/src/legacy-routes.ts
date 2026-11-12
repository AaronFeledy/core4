import { ProxySetupError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";

import { recognizeLegacyRouteFile } from "./legacy-route-content.ts";
import { dynamicConfigDir, joinFor } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { isRouteFileName } from "./route-file-metadata.ts";

// Callers hold the Windows route mutation lock across discovery, removal, and
// reload. Restore the evidence on failure so even a fresh router instance retries.
export const migrateLegacyRoutes = Effect.fn("TraefikRouter.migrateLegacyRoutes")(function* (
  dependencies: TraefikProxyDependencies,
) {
  const { fileSystem, paths } = dependencies;
  const directory = dynamicConfigDir(paths);
  if (!(yield* fileSystem.exists(directory))) return;
  const generated: Array<{
    readonly path: string;
    readonly content: string;
  }> = [];
  for (const name of (yield* fileSystem.readDir(directory)).filter(isRouteFileName)) {
    const path = joinFor(paths)(directory, name);
    const content = yield* fileSystem.readText(path);
    const legacy = recognizeLegacyRouteFile(name, content);
    if (legacy !== undefined) generated.push({ path, content, ...legacy });
  }
  if (generated.length === 0) return;
  // Route content proves only route ownership; referenced certificate bytes may
  // have been replaced by the user and carry no independent ownership proof.
  yield* Effect.gen(function* () {
    for (const file of generated) yield* fileSystem.remove(file.path);
    if (paths.platform === "win32") {
      const restart = dependencies.globalApp.restartRunningService;
      if (restart === undefined)
        return yield* Effect.fail(
          new ProxySetupError({
            message: "Cannot reload Traefik after legacy route migration.",
            proxyId: "traefik",
            remediation: "Retry with a global app runtime that supports router reloads.",
          }),
        );
      yield* restart(ServiceName.make("traefik"));
    }
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        for (const file of generated) yield* fileSystem.writeAtomic(file.path, file.content);
      }).pipe(Effect.orDie),
    ),
  );
});
