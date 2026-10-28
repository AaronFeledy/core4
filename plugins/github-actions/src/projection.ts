import { isMapping, isSequence, isString } from "@actions/workflow-parser";
import { isActionStep, isJob, isRunStep } from "@actions/workflow-parser/model/type-guards";
import type { WorkflowJob } from "@actions/workflow-parser/model/workflow-template";
import type { TemplateToken } from "@actions/workflow-parser/templates/tokens/template-token";
import { location, safeText } from "./diagnostics.ts";
import type { InspectionJob, InspectionStep, SourceLocation } from "./schema.ts";

export const tokenLocation = (name: string, token?: TemplateToken): SourceLocation =>
  location(name, token?.range?.start);

export const assessRunner = (
  token?: TemplateToken,
): Pick<InspectionJob, "runnerLabels" | "runnerAssessment"> => {
  if (token === undefined) return { runnerLabels: [], runnerAssessment: "unassessed" };
  const labels = isMapping(token) ? token.find("labels") : token;
  const values =
    labels !== undefined && isSequence(labels) ? Array.from(labels) : labels === undefined ? [] : [labels];
  const literal = values.filter(isString).map((value) => safeText(value.value));
  return {
    runnerLabels: literal,
    runnerAssessment:
      values.length > 0 && values.every(isString) && !isMapping(token) ? "literal" : "unresolved",
  };
};

export const projectJob = (name: string, job: WorkflowJob): InspectionJob => {
  const common = {
    id: safeText(job.id.value),
    source: tokenLocation(name, job.id),
    needs: (job.needs ?? []).map((need) => safeText(need.value)),
    matrix:
      job.strategy === undefined || (isMapping(job.strategy) && job.strategy.find("matrix") === undefined)
        ? ("absent" as const)
        : ("unassessed" as const),
  };
  if (!isJob(job))
    return {
      ...common,
      kind: "reusable-workflow",
      runnerLabels: [],
      runnerAssessment: "unassessed",
      steps: [],
    };
  const steps: (typeof InspectionStep.Type)[] = job.steps.map((step) => {
    if (isRunStep(step)) return { source: tokenLocation(name, step.run), category: "script" };
    if (isActionStep(step)) {
      const value = step.uses.value;
      const category = value.includes("${{")
        ? "unresolved-action"
        : value.startsWith("./")
          ? "local-action"
          : value.startsWith("docker://")
            ? "container-action"
            : "repository-action";
      return { source: tokenLocation(name, step.uses), category };
    }
    return { source: tokenLocation(name, job.id), category: "unassessed" };
  });
  return { ...common, kind: "job", ...assessRunner(job["runs-on"]), steps };
};
