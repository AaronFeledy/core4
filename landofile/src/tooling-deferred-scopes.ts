import { NotImplementedError } from "@lando/sdk/errors";
import { type ExpressionTemplate, expressionScopeMembers } from "@lando/sdk/expressions";
import { executableExpressionPath } from "./invocation-sites.ts";

export const deferredToolingScopeError = (
  template: ExpressionTemplate,
  path: readonly (string | number)[],
  file: string,
): NotImplementedError | undefined => {
  if (!executableExpressionPath(path)) return undefined;
  for (const scope of ["service", "sources", "generates", "checksum", "timestamp"]) {
    const reads = expressionScopeMembers(template, scope);
    if (!reads.analyzable || reads.members.size > 0)
      return new NotImplementedError({
        commandId: "landofile.parse",
        message: `${path.join(".")} in ${file}: Invocation scope ${scope} is not implemented.`,
        remediation: `Replace ${scope} at ${path.join(".")} with declared flags, args, task identity, raw input, or a tooling var; ${scope} invocation metadata is not available yet.`,
      });
  }
  return undefined;
};
