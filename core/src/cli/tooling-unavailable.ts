import type { BunShellScriptDiscoveryError } from "@lando/landofile/bun-sh-discovery";
import { resolveBunShellScript } from "@lando/landofile/bun-sh-script";
import { ToolingCompileError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { ToolingRoute } from "./tooling-route";

/** Scripts re-read their source; tooling help uses the fresh index's deterministic diagnostic. */
export const unavailableToolingError = (
  route: ToolingRoute,
): Effect.Effect<BunShellScriptDiscoveryError | ToolingCompileError | undefined> => {
  switch (route._tag) {
    case "bun-script":
      return resolveBunShellScript(route.appRoot, route.commandId).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
      );
    case "tooling":
      return Effect.succeed(
        route.loadError === undefined
          ? undefined
          : new ToolingCompileError({
              ...("issues" in route.loadError ? route.loadError : {}),
              tool: "issues" in route.loadError ? route.loadError.tool : route.name,
              ...("issues" in route.loadError || route.sourcePath === undefined
                ? {}
                : { source: { path: route.sourcePath, task: route.name } }),
              message: route.loadError.message,
              remediation: route.loadError.remediation ?? "Correct this task's tooling declaration.",
            }),
      );
    case "not-tooling":
    case "built-in":
    case "plugin":
    case "alias-disabled":
    case "cache-miss":
    case "unknown-tooling":
      return Effect.succeed(undefined);
    default:
      return route satisfies never;
  }
};
