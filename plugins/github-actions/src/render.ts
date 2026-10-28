import { limits, safeText } from "./diagnostics.ts";
import type {
  InspectedWorkflow,
  InspectionJob,
  SourceLocation,
  WorkflowDiagnostic,
  WorkflowInspection,
} from "./schema.ts";

// Every data-derived string passes through safeText (idempotent) so rendered
// text never carries terminal or bidi controls, even from a foreign producer.

const count = (total: number, singular: string, plural = `${singular}s`) =>
  `${total} ${total === 1 ? singular : plural}`;
const list = (values: readonly string[]) => values.map(safeText).join(", ");
// Keeps one dependency list from wrapping into a dozen terminal rows.
const shortList = (values: readonly string[]) =>
  values.length <= 6 ? list(values) : `${list(values.slice(0, 5))}, and ${values.length - 5} more`;
const reference = (source: SourceLocation) =>
  source.line === undefined
    ? safeText(source.workflow)
    : `${safeText(source.workflow)}:${source.line}${source.column === undefined ? "" : `:${source.column}`}`;

// Prose only (remediations, notes): word-wrapped at a conservative 78 columns
// with a hanging indent, so sentences never break mid-word on a narrow terminal.
const wrap = (text: string, indent: string): string[] => {
  const rows: string[] = [];
  for (const word of text.split(" ")) {
    const last = rows.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= 78) rows[rows.length - 1] = `${last} ${word}`;
    else rows.push(`${indent}${word}`);
  }
  return rows;
};

const stepNouns: Record<InspectionJob["steps"][number]["category"], string> = {
  script: "script",
  "repository-action": "action",
  "local-action": "local action",
  "container-action": "container action",
  "unresolved-action": "dynamic action",
  unassessed: "unassessed step",
};
const describeSteps = (steps: InspectionJob["steps"]): string => {
  if (steps.length === 0) return "no steps";
  const tally = new Map<string, number>();
  for (const step of steps) tally.set(step.category, (tally.get(step.category) ?? 0) + 1);
  return Object.entries(stepNouns)
    .flatMap(([category, noun]) => {
      const total = tally.get(category);
      return total === undefined ? [] : [count(total, noun)];
    })
    .join(", ");
};

const describeRunner = (job: InspectionJob): string => {
  const labels = list(job.runnerLabels);
  switch (job.runnerAssessment) {
    case "literal":
      return labels;
    case "unresolved":
      return labels === "" ? "dynamic runner" : `dynamic runner (${labels})`;
    case "unassessed":
      return "runner unassessed";
    default: {
      const exhaustive: never = job.runnerAssessment;
      return exhaustive;
    }
  }
};
const matrixNote: Record<InspectionJob["matrix"], string> = { unassessed: "matrix", absent: "" };
const describeJob = (job: InspectionJob): string => {
  const facts = [matrixNote[job.matrix]];
  switch (job.kind) {
    case "job":
      facts.push(describeRunner(job), describeSteps(job.steps));
      break;
    case "reusable-workflow":
      facts.push("reusable workflow (not fetched)");
      break;
    default: {
      const exhaustive: never = job.kind;
      return exhaustive;
    }
  }
  return facts.filter((fact) => fact !== "").join("  ");
};

const describeJobs = (jobs: readonly InspectionJob[]): string[] => {
  const width = jobs.reduce((max, job) => Math.max(max, String(job.source.line ?? "").length), 0);
  return jobs.flatMap((job) => [
    `  ${String(job.source.line ?? "").padStart(width)} | ${safeText(job.id)}  ${describeJob(job)}`,
    ...(job.needs.length === 0 ? [] : [`  ${" ".repeat(width)} |   needs: ${shortList(job.needs)}`]),
  ]);
};

// Code, rule, and structural path are schema literals, never authored keys or
// values; the rule is shown only when the code does not already end with it.
const describeFinding = (item: WorkflowDiagnostic): string => {
  const path = (item.path ?? (item.field === undefined ? [] : [item.field])).filter(
    (segment, index) => index > 0 || segment !== "workflow",
  );
  const rule = item.rule === undefined || item.code.endsWith(item.rule) ? "" : ` (${item.rule})`;
  return `${item.code}${rule}${path.length === 0 ? "" : ` in ${path.join(".")}`}`;
};
// Compiler style: one `reference  finding` row per located occurrence, then
// the remediation once per finding. A file-level finding has no reference
// because the workflow heading already names the file.
const describeDiagnostics = (workflow: InspectedWorkflow): string[] => {
  const groups = new Map<
    string,
    { readonly finding: string; readonly fix: string; readonly sources: SourceLocation[] }
  >();
  for (const item of workflow.diagnostics) {
    const finding = describeFinding(item);
    const key = `${finding}\n${item.remediation}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { finding, fix: item.remediation, sources: [item.source] });
    else group.sources.push(item.source);
  }
  const lines = [...groups.values()].flatMap(({ finding, fix, sources }) => [
    ...sources
      .filter((source) => source.line !== undefined)
      .map((source) => `  ${reference(source)}  ${finding}`),
    ...(sources.some((source) => source.line === undefined) ? [`  ${finding}`] : []),
    ...wrap(safeText(fix), "    "),
  ]);
  if (workflow.diagnosticsTruncated)
    lines.push(
      ...wrap(
        `Only the first ${limits.errors} errors are shown; fix them and inspect again for the rest.`,
        "  ",
      ),
    );
  return lines;
};

const workflowStatus = (workflow: InspectedWorkflow): string => {
  switch (workflow.status) {
    case "inspected":
      return "ok";
    case "failed":
      return workflow.diagnosticsTruncated
        ? `${workflow.diagnostics.length}+ errors`
        : count(workflow.diagnostics.length, "error");
    case "uninspected":
      return "not inspected";
    default: {
      const exhaustive: never = workflow.status;
      return exhaustive;
    }
  }
};
const describeWorkflow = (workflow: InspectedWorkflow): string[] => {
  const name = workflow.name === undefined ? "" : `  ${safeText(workflow.name)}`;
  return [
    `${safeText(workflow.source.workflow)}${name}  ${workflowStatus(workflow)}`,
    ...describeDiagnostics(workflow),
    ...(workflow.triggers.length === 0 ? [] : [`  on: ${list(workflow.triggers)}`]),
    ...describeJobs(workflow.jobs),
  ];
};

const summarize = (result: WorkflowInspection): string => {
  const { summary } = result;
  const jobs = result.workflows.reduce((total, workflow) => total + workflow.jobs.length, 0);
  const parts = [count(summary.discovered, "workflow")];
  if (jobs > 0) parts.push(count(jobs, "job"));
  if (summary.failed > 0) parts.push(`${summary.failed} with errors`);
  else if (summary.discovered > 0) parts.push("no errors");
  if (summary.uninspected > 0) parts.push(`${summary.uninspected} not inspected`);
  return `GitHub Actions (offline): ${parts.join(", ")}`;
};

// A path is echoed into a command line only when no shell needs it quoted and
// no argv parser can mistake it for a flag.
const shellSafe = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/u;
const nextStep = (result: WorkflowInspection): string[] => {
  const first = result.workflows.find((workflow) => workflow.status === "uninspected");
  if (first === undefined) return [];
  const path = safeText(first.source.workflow);
  return [
    'Next: inspect each workflow marked "not inspected" on its own:',
    ...(shellSafe.test(path)
      ? [`  lando github-actions:list --workflow ${path}`]
      : [
          "  lando github-actions:list --workflow <path>",
          '  (replace <path> with a path marked "not inspected", quoted for your shell)',
        ]),
  ];
};

export const renderInspection = (result: WorkflowInspection): string => {
  if (result.summary.discovered === 0)
    return [
      summarize(result),
      ...wrap(
        "No workflow files found in .github/workflows (.yml or .yaml). Add one there, or pass --root <directory> when this is not the repository root.",
        "  ",
      ),
    ].join("\n");
  return [
    summarize(result),
    ...result.workflows.flatMap((workflow) => ["", ...describeWorkflow(workflow)]),
    "",
    ...wrap(
      "Nothing was executed. Expressions, reusable workflow bodies, matrix expansion, and runner compatibility were not evaluated.",
      "",
    ),
    ...nextStep(result),
  ].join("\n");
};
