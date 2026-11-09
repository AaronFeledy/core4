import type { AppRouteOwner } from "@lando/sdk/schema";
import { Effect } from "effect";
import { routeFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { acceptanceError } from "./route-acceptance.ts";
import { parseRouteFileMetadata } from "./route-file-metadata.ts";

export const requireOwnedRouteFile = Effect.fn("TraefikRouter.requireOwnedRouteFile")(function* (
  dependencies: TraefikProxyDependencies,
  owner: AppRouteOwner,
) {
  const file = routeFile(dependencies.paths, owner);
  if (!(yield* dependencies.fileSystem.exists(file))) return;
  const content = yield* dependencies.fileSystem.readText(file);
  if (parseRouteFileMetadata(content) === undefined) {
    return yield* Effect.fail(acceptanceError(owner.id, "unattributable-route-file"));
  }
});
