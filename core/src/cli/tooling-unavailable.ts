import type { CommandLoadError } from "@lando/engine/cache/command-index";
import type { BunShellScriptDiscoveryError } from "@lando/landofile/bun-sh-discovery";
import { resolveBunShellScript } from "@lando/landofile/bun-sh-script";
import { ToolingCompileError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { ToolingRoute } from "./tooling-route";

// The index decoder reserves this tag for the structured tooling diagnostic.
export const isToolingDiagnostic = (
  diagnostic: CommandLoadError,
): diagnostic is Pick<
  ToolingCompileError,
  "_tag" | "tool" | "source" | "message" | "remediation" | "issues" | "omittedIssueCount"
> => diagnostic._tag === "ToolingCompileError";

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
      switch (route.availability._tag) {
        case "Ready":
        case "Disabled":
          return Effect.succeed(undefined);
        case "Unavailable": {
          const diagnostic = route.availability.diagnostic;
          const structured = isToolingDiagnostic(diagnostic);
          return Effect.succeed(
            new ToolingCompileError({
              ...(structured ? diagnostic : {}),
              tool: structured ? diagnostic.tool : route.name,
              message: diagnostic.message,
              remediation: diagnostic.remediation ?? "Correct this task's tooling declaration.",
            }),
          );
        }
        default:
          return route.availability satisfies never;
      }
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
