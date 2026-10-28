/** Private acceptance map: each implemented planning claim names executable evidence and its limit. */
export const planningCapabilities = Object.freeze([
  {
    field: "jobs.needs",
    evaluator: "planning/graph.validateJobGraph",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "256 jobs; unknown, self, duplicate identities and cycles rejected",
  },
  {
    field: "jobs.if",
    evaluator: "contexts.evaluateCondition",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "before matrix; unavailable contexts deferred; status functions use supplied graph conclusions",
  },
  {
    field: "strategy.matrix",
    evaluator: "planning/matrix.expandMatrix",
    fixture: "test/matrix.test.ts",
    assessment: "implemented",
    limits:
      "256 pre-product and total workflow legs; 65536 comparison/work units; 10000 JSON nodes; depth20; 256KiB",
  },
  {
    field: "strategy.max-parallel",
    evaluator: "planning/plan.advancePlan",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "four local slots; caller may narrow; supplied active cancellations retain slots",
  },
  {
    field: "strategy.fail-fast",
    evaluator: "planning/plan.advancePlan",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "cancellation decisions require external completion; no workload execution",
  },
  {
    field: "jobs.continue-on-error",
    evaluator: "planning/plan.advancePlan",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "outcome retained separately from conclusion",
  },
  {
    field: "jobs.timeout-minutes",
    evaluator: "planning/plan.advancePlan",
    fixture: "test/job-graph.test.ts",
    assessment: "implemented",
    limits: "supplied elapsed milliseconds on active legs; cancellation request only",
  },
  {
    field: "jobs.outputs",
    evaluator: "planning/plan.advancePlan",
    fixture: "test/job-graph.test.ts",
    assessment: "deferred",
    limits:
      "externally resolved JOB output facts; declared outputs unavailable until supplied; matrix merge follows supplied completion order",
  },
  {
    field: "steps.uses",
    evaluator: "planning/plan.assessActions",
    fixture: "test/planning-integration.test.ts",
    assessment: "partial",
    limits:
      "actual metadata from opaque fixture-verified sources; missing metadata deferred; no action workload or lifecycle implementation",
  },
  {
    field: "jobs.concurrency",
    evaluator: "planning/plan.unsupported",
    fixture: "test/job-graph.test.ts",
    assessment: "unsupported",
    limits: "local/global group arbitration gated",
  },
  {
    field: "reuse/composite",
    evaluator: "planning/plan.unsupported",
    fixture: "test/job-graph.test.ts",
    assessment: "unsupported",
    limits: "expansion/nesting/cycle runtime gated",
  },
  {
    field: "execution",
    evaluator: "planning/project.projectPlan",
    fixture: "test/planning-integration.test.ts",
    assessment: "execution-unassessed",
    limits: "no process, provider, network or credentials",
  },
] as const);
