import type { Diagnostic, Rule } from "../types.ts";

// Sentinels of the one ownership-marker/overwrite implementation. A host-project
// file writer that re-spells these is hand-rolling managed-file logic instead of
// delegating to `ManagedFileService`. `x-lando-generated` is caught by the
// `lando-generated` tag, and the fences are the `block`-mode markers.
const SENTINELS = ["lando-generated", ">>> lando:", "<<< lando:"] as const;

const analyzeSource = (file: string, sourceText: string): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = [];
  sourceText.split(/\r?\n/u).forEach((text, index) => {
    const hit = SENTINELS.find((sentinel) => text.includes(sentinel));
    if (hit !== undefined) {
      diagnostics.push({
        ruleId: "managed-file-boundary",
        file,
        line: index + 1,
        message: hit,
      });
    }
  });
  return diagnostics;
};

export const managedFileBoundaryRule: Rule = {
  id: "managed-file-boundary",
  title: "Managed-file boundary",
  failureHeadline:
    "Managed-file boundary check failed. Host project-file ownership-marker/overwrite logic must route through ManagedFileService (core/src/managed-file/).",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (
      await Promise.all(
        files.map(async (file) => analyzeSource(file.relativePath, await context.sourceText(file))),
      )
    ).flat();
  },
};
