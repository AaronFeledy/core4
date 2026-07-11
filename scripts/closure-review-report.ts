export type ClosureLaneId = "goal" | "qa" | "code-quality" | "security" | "context-history";
export type ClosureDisposition = "approved" | "blocked" | "inconclusive";
export type ClosureInconclusiveClass = "timeout" | "empty-output" | "instructions-only" | "no-repo-access";

export interface ClosureFindingResolutionFixed {
  readonly kind: "fixed-and-re-reviewed";
  readonly evidence: string;
}

export interface ClosureFindingResolutionLinkedStory {
  readonly kind: "linked-beta-story";
  readonly storyId: string;
  readonly rationale: string;
  readonly sources: readonly string[];
}

export type ClosureFindingResolution = ClosureFindingResolutionFixed | ClosureFindingResolutionLinkedStory;

export interface ClosureFindingReport {
  readonly title: string;
  readonly severity: "note" | "blocker";
  readonly sources: readonly string[];
  readonly resolution?: ClosureFindingResolution;
}

export interface ClosureLaneReport {
  readonly id: ClosureLaneId;
  readonly scope: string;
  readonly inputs: readonly string[];
  readonly commandsOrTools: readonly string[];
  readonly evidence: readonly string[];
  readonly findings: readonly ClosureFindingReport[];
  readonly disposition: ClosureDisposition;
  readonly residualRisks: readonly string[];
  readonly inconclusiveClass?: ClosureInconclusiveClass;
}

export interface ClosureReviewReport {
  readonly schemaVersion: 1;
  readonly approved: boolean;
  readonly lanes: readonly ClosureLaneReport[];
  readonly errors: readonly string[];
}

const REQUIRED_LANES = ["goal", "qa", "code-quality", "security", "context-history"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLaneId = (value: unknown): value is ClosureLaneId => {
  switch (value) {
    case "goal":
    case "qa":
    case "code-quality":
    case "security":
    case "context-history":
      return true;
    default:
      return false;
  }
};

const isDisposition = (value: unknown): value is ClosureDisposition => {
  switch (value) {
    case "approved":
    case "blocked":
    case "inconclusive":
      return true;
    default:
      return false;
  }
};

const isInconclusiveClass = (value: unknown): value is ClosureInconclusiveClass => {
  switch (value) {
    case "timeout":
    case "empty-output":
    case "instructions-only":
    case "no-repo-access":
      return true;
    default:
      return false;
  }
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? value : undefined;
};

const nonEmptyText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const validateStringList = (
  laneId: ClosureLaneId,
  field: string,
  value: unknown,
  errors: string[],
): readonly string[] => {
  const parsed = stringArray(value);
  if (parsed === undefined || parsed.length === 0) errors.push(`${laneId} lane requires ${field}`);
  return parsed ?? [];
};

const parseResolution = (
  laneId: ClosureLaneId,
  title: string,
  value: unknown,
  failingStoryIds: ReadonlySet<string>,
  errors: string[],
): ClosureFindingResolution | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind === "fixed-and-re-reviewed") {
    const evidence = nonEmptyText(value.evidence);
    if (evidence === undefined)
      errors.push(`${laneId} blocker "${title}" requires fixed-and-re-reviewed evidence`);
    return evidence === undefined ? undefined : { kind, evidence };
  }
  if (kind === "linked-beta-story") {
    const storyId = nonEmptyText(value.storyId);
    const rationale = nonEmptyText(value.rationale);
    const sources = stringArray(value.sources);
    const linksFailingStory = storyId !== undefined && failingStoryIds.has(storyId);
    if (storyId === undefined) errors.push(`${laneId} blocker "${title}" requires a Beta 1 story link`);
    if (storyId !== undefined && !linksFailingStory)
      errors.push(`${laneId} blocker "${title}" must link to a currently failing Beta 1 story`);
    if (rationale === undefined || sources === undefined || sources.length === 0)
      errors.push(`${laneId} blocker "${title}" requires source-backed rationale`);
    if (!linksFailingStory || rationale === undefined || sources === undefined) return undefined;
    return { kind, storyId, rationale, sources };
  }
  errors.push(`${laneId} blocker "${title}" has unsupported resolution`);
  return undefined;
};

const parseFinding = (
  laneId: ClosureLaneId,
  value: unknown,
  failingStoryIds: ReadonlySet<string>,
  errors: string[],
): ClosureFindingReport | undefined => {
  if (!isRecord(value)) return undefined;
  const title = nonEmptyText(value.title);
  const severity = value.severity;
  const sources = stringArray(value.sources);
  if (
    title === undefined ||
    (severity !== "note" && severity !== "blocker") ||
    sources === undefined ||
    sources.length === 0
  ) {
    errors.push(`${laneId} lane has an invalid finding`);
    return undefined;
  }
  const resolution = parseResolution(laneId, title, value.resolution, failingStoryIds, errors);
  if (severity === "blocker" && resolution === undefined)
    errors.push(`${laneId} blocker "${title}" is unresolved`);
  return resolution === undefined ? { title, severity, sources } : { title, severity, sources, resolution };
};

const parseLane = (
  value: unknown,
  failingStoryIds: ReadonlySet<string>,
  errors: string[],
): ClosureLaneReport | undefined => {
  if (!isRecord(value) || !isLaneId(value.id)) return undefined;
  const id = value.id;
  const scope = nonEmptyText(value.scope);
  const disposition = value.disposition;
  const findingsValue = value.findings;
  if (scope === undefined) errors.push(`${id} lane requires scope`);
  if (!isDisposition(disposition)) errors.push(`${id} lane requires disposition`);
  const inputs = validateStringList(id, "inputs", value.inputs, errors);
  const commandsOrTools = validateStringList(id, "commandsOrTools", value.commandsOrTools, errors);
  const evidence = stringArray(value.evidence);
  if (evidence === undefined || (disposition !== "inconclusive" && evidence.length === 0))
    errors.push(`${id} lane requires evidence`);
  const residualRisks = validateStringList(id, "residualRisks", value.residualRisks, errors);
  const findings = Array.isArray(findingsValue)
    ? findingsValue.flatMap((entry) => {
        const finding = parseFinding(id, entry, failingStoryIds, errors);
        return finding === undefined ? [] : [finding];
      })
    : [];
  if (!Array.isArray(findingsValue) || findings.length === 0) errors.push(`${id} lane requires findings`);
  if (scope === undefined || !isDisposition(disposition) || evidence === undefined) return undefined;
  const inconclusiveClass = value.inconclusiveClass;
  if (disposition === "inconclusive") {
    if (!isInconclusiveClass(inconclusiveClass)) errors.push(`${id} lane requires an inconclusive class`);
    else errors.push(`${id} lane is inconclusive: ${inconclusiveClass}`);
  }
  return isInconclusiveClass(inconclusiveClass)
    ? {
        id,
        scope,
        inputs,
        commandsOrTools,
        evidence,
        findings,
        disposition,
        residualRisks,
        inconclusiveClass,
      }
    : { id, scope, inputs, commandsOrTools, evidence, findings, disposition, residualRisks };
};

const unresolvedBlockerErrors = (lane: ClosureLaneReport): readonly string[] =>
  lane.findings.flatMap((finding) => {
    if (finding.severity !== "blocker") return [];
    if (finding.resolution?.kind === "fixed-and-re-reviewed") return [];
    if (finding.resolution?.kind === "linked-beta-story")
      return [
        `${lane.id} blocker "${finding.title}" remains linked to failing story ${finding.resolution.storyId}`,
      ];
    return [`${lane.id} blocker "${finding.title}" is unresolved`];
  });

export const failedClosureReviewReport = (errors: readonly string[]): ClosureReviewReport => ({
  schemaVersion: 1,
  approved: false,
  lanes: [],
  errors,
});

export const evaluateClosureReviewInput = (
  input: unknown,
  failingStoryIdsInput: readonly string[] = [],
): ClosureReviewReport => {
  const errors: string[] = [];
  const failingStoryIds = new Set(failingStoryIdsInput);
  if (!isRecord(input) || !Array.isArray(input.lanes))
    return failedClosureReviewReport(["closure review input must include lanes"]);
  const lanes = input.lanes.flatMap((entry) => {
    const lane = parseLane(entry, failingStoryIds, errors);
    if (lane === undefined) errors.push("closure review input contains an invalid lane");
    return lane === undefined ? [] : [lane];
  });
  for (const id of REQUIRED_LANES) {
    const count = lanes.filter((lane) => lane.id === id).length;
    if (count === 0) errors.push(`missing required lane: ${id}`);
    if (count > 1) errors.push(`duplicate lane: ${id}`);
  }
  for (const lane of lanes)
    if (lane.disposition !== "approved") errors.push(`${lane.id} lane disposition is ${lane.disposition}`);
  for (const lane of lanes) errors.push(...unresolvedBlockerErrors(lane));
  return { schemaVersion: 1, approved: errors.length === 0, lanes, errors };
};
