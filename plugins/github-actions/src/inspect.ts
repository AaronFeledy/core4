import { convertWorkflowTemplate, isMapping, isString } from "@actions/workflow-parser";
import { ErrorPolicy } from "@actions/workflow-parser/model/convert";
import { Effect } from "effect";
import { diagnostic, limits, location, safeText } from "./diagnostics.ts";
import { readLanguageTokens } from "./language/parse.ts";
import { parserDiagnostic } from "./parser-diagnostics.ts";
import { preflight } from "./preflight.ts";
import { projectJob, tokenLocation } from "./projection.ts";
import type { InspectedWorkflow } from "./schema.ts";

export const inspectWorkflow = Effect.fn("GithubActions.inspectWorkflow")(function* (
  name: string,
  content: string,
) {
  const empty: InspectedWorkflow = {
    source: location(name),
    status: "failed",
    triggers: [],
    jobs: [],
    diagnostics: [],
    diagnosticsTruncated: false,
  };
  return yield* Effect.tryPromise({
    try: async (): Promise<InspectedWorkflow> => {
      const guard = preflight(name, content);
      if (guard.status === "rejected") return { ...empty, diagnostics: [guard.diagnostic] };
      const parsed = readLanguageTokens(name, content, "workflow", {
        sourceIndex: guard.index,
        aliasProvenance: [],
      });
      const context = parsed.context;
      const template =
        parsed.value === undefined || context.errors.count > 0
          ? undefined
          : await convertWorkflowTemplate(context, parsed.value, undefined, {
              fetchReusableWorkflowDepth: 0,
              errorPolicy: ErrorPolicy.TryConversion,
            });
      const errors = context.errors.getErrors();
      const diagnostics = errors
        .slice(0, limits.errors)
        .map((error) => parserDiagnostic(name, error, guard.index));
      if (template === undefined && diagnostics.length === 0)
        diagnostics.push(diagnostic("workflow-invalid", location(name)));
      const nameToken =
        parsed.value !== undefined && isMapping(parsed.value) ? parsed.value.find("name") : undefined;
      return {
        ...empty,
        source: tokenLocation(name, parsed.value),
        ...(nameToken !== undefined && isString(nameToken) ? { name: safeText(nameToken.value) } : {}),
        status: diagnostics.length > 0 ? "failed" : "inspected",
        triggers: template === undefined ? [] : Object.keys(template.events).sort().map(safeText),
        jobs: template === undefined ? [] : template.jobs.map((job) => projectJob(name, job)),
        diagnostics,
        diagnosticsTruncated: errors.length > limits.errors,
      };
    },
    catch: () => ({ ...empty, diagnostics: [diagnostic("parser-failure", location(name))] }),
  }).pipe(Effect.catch((row) => Effect.succeed(row)));
});
