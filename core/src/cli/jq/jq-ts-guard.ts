import type { parse } from "@gabrielbryk/jq-ts";

// 1e6 is a false-positive posture: legitimate huge-literal assignment/multiply is
// refused because maxSteps does not tick during array hole-fill or string-repeat allocation.
export const HUGE_LITERAL_THRESHOLD = 1_000_000;

const REJECTED = "jq expression rejected: unbounded index or allocation";

type Findings = {
  hasAssignment: boolean;
  hasSetpathLikeCall: boolean;
  hasHugeMultiply: boolean;
  hasHugeIndexLiteral: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isHugeNumberLiteral = (value: unknown): boolean => {
  if (!isRecord(value) || value.kind !== "Literal") {
    return false;
  }
  const literal = value.value;
  return typeof literal === "number" && Math.abs(literal) >= HUGE_LITERAL_THRESHOLD;
};

const markSetpathPathIndexes = (node: Record<string, unknown>, findings: Findings): void => {
  const args = node.args;
  if (!Array.isArray(args)) {
    return;
  }
  const pathArg = args[0];
  if (!isRecord(pathArg) || pathArg.kind !== "Array" || !Array.isArray(pathArg.items)) {
    return;
  }
  for (const item of pathArg.items) {
    if (isHugeNumberLiteral(item)) {
      findings.hasHugeIndexLiteral = true;
    }
  }
};

const walk = (node: unknown, findings: Findings, inAssignmentLeft: boolean): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, findings, inAssignmentLeft);
    }
    return;
  }
  if (!isRecord(node) || typeof node.kind !== "string") {
    return;
  }

  if (node.kind === "Assignment") {
    findings.hasAssignment = true;
  }
  if (node.kind === "Call" && (node.name === "setpath" || node.name === "delpaths")) {
    findings.hasSetpathLikeCall = true;
    markSetpathPathIndexes(node, findings);
  }
  if (node.kind === "Binary" && node.op === "*") {
    if (isHugeNumberLiteral(node.left) || isHugeNumberLiteral(node.right)) {
      findings.hasHugeMultiply = true;
    }
  }
  if (inAssignmentLeft && node.kind === "IndexAccess" && isHugeNumberLiteral(node.index)) {
    findings.hasHugeIndexLiteral = true;
  }

  for (const [key, value] of Object.entries(node)) {
    const nextInLeft = node.kind === "Assignment" ? key === "left" : inAssignmentLeft;
    if (Array.isArray(value) || (isRecord(value) && typeof value.kind === "string")) {
      walk(value, findings, nextInLeft);
    }
  }
};

export const assertJqExpressionSafe = (ast: ReturnType<typeof parse>): void => {
  const findings: Findings = {
    hasAssignment: false,
    hasSetpathLikeCall: false,
    hasHugeMultiply: false,
    hasHugeIndexLiteral: false,
  };
  walk(ast, findings, false);
  const rejectsIndex =
    (findings.hasAssignment || findings.hasSetpathLikeCall) && findings.hasHugeIndexLiteral;
  if (findings.hasHugeMultiply || rejectsIndex) {
    throw new Error(REJECTED);
  }
};
