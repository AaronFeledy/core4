import type { Redactor } from "@lando/sdk/secrets";
import type { HelpCatalogResult } from "./compiled-help";
import { publishCommandDiagnostic, publishDiagnosticSummary } from "./diagnostic-publication";
import type { HelpCommandTargetDescriptor } from "./help-command-descriptor";

export const publishHelpDescriptor = <
  A extends HelpCatalogResult["all"][number] | typeof HelpCommandTargetDescriptor.Type,
>(
  descriptor: A,
  redactor: Pick<Redactor, "redactString">,
): A => {
  switch (descriptor.source) {
    case "built-in":
      return descriptor;
    case "plugin":
      return {
        ...descriptor,
        ...(descriptor.loadError === undefined
          ? {}
          : { loadError: publishDiagnosticSummary(descriptor.loadError, redactor) }),
      };
    case "tooling":
      return {
        ...descriptor,
        ...(descriptor.loadError === undefined
          ? {}
          : { loadError: publishCommandDiagnostic(descriptor.loadError, redactor) }),
      };
    default:
      return descriptor satisfies never;
  }
};

export const publishHelpCatalog = (
  catalog: HelpCatalogResult,
  redactor: Pick<Redactor, "redactString">,
): HelpCatalogResult => {
  const metadata = catalog.pluginMetadata;
  const tooling = catalog.toolingMetadata;
  const rows = (entries: HelpCatalogResult["all"]) =>
    entries.map((entry) => publishHelpDescriptor(entry, redactor));
  return {
    ...catalog,
    pluginMetadata:
      metadata.status === "unavailable"
        ? publishDiagnosticSummary(metadata, redactor)
        : {
            ...metadata,
            ...(metadata.diagnostics === undefined
              ? {}
              : {
                  diagnostics: metadata.diagnostics.map((entry) => publishDiagnosticSummary(entry, redactor)),
                }),
          },
    toolingMetadata:
      tooling.status === "unavailable"
        ? {
            ...tooling,
            remediation: publishDiagnosticSummary({ message: tooling.remediation }, redactor).message,
            ...(tooling.reason === "rebuild-failed"
              ? { error: publishDiagnosticSummary(tooling.error, redactor) }
              : {}),
          }
        : tooling,
    sections: {
      common: rows(catalog.sections.common),
      thisApp: rows(catalog.sections.thisApp),
      more: rows(catalog.sections.more),
    },
    all: rows(catalog.all),
  };
};
