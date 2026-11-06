import { includeError } from "./include-guard.ts";

export const selectorLabel = (selector: string | undefined): string => selector ?? "<default>";

export const reserveIncludeSelector = (
  selectors: Map<string, string | undefined>,
  request: { readonly sourceId: string; readonly version: string | undefined },
): void => {
  if (selectors.has(request.sourceId) && selectors.get(request.sourceId) !== request.version)
    throw includeError({
      message: `Conflicting selectors for ${request.sourceId}: ${selectorLabel(selectors.get(request.sourceId))} and ${selectorLabel(request.version)}.`,
      source: request.sourceId,
      kind: "source-unresolved",
      remediation: "Include each remote fragment at one version.",
    });
  selectors.set(request.sourceId, request.version);
};
