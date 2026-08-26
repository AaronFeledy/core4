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

const BINARY_ARITH = {
  "+": (left: number, right: number): number => left + right,
  "-": (left: number, right: number): number => left - right,
  "*": (left: number, right: number): number => left * right,
  "/": (left: number, right: number): number => left / right,
  "%": (left: number, right: number): number => left % right,
} as const;

type BinaryArithOp = keyof typeof BINARY_ARITH;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isBinaryArithOp = (op: unknown): op is BinaryArithOp =>
  typeof op === "string" && Object.hasOwn(BINARY_ARITH, op);

const foldNumeric = (node: unknown): number | undefined => {
  if (!isRecord(node) || typeof node.kind !== "string") {
    return undefined;
  }
  if (node.kind === "Literal") {
    return typeof node.value === "number" ? node.value : undefined;
  }
  if (node.kind === "Unary" && node.op === "Neg") {
    const inner = foldNumeric(node.expr);
    return inner === undefined ? undefined : -inner;
  }
  if (node.kind !== "Binary" || !isBinaryArithOp(node.op)) {
    return undefined;
  }
  const left = foldNumeric(node.left);
  const right = foldNumeric(node.right);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  if ((node.op === "/" || node.op === "%") && right === 0) {
    return undefined;
  }
  return BINARY_ARITH[node.op](left, right);
};

const isHugeFoldedNumber = (value: unknown): boolean => {
  const folded = foldNumeric(value);
  return folded !== undefined && Math.abs(folded) >= HUGE_LITERAL_THRESHOLD;
};

const collectNumericMultiplyFactors = (node: unknown): readonly number[] => {
  if (isRecord(node) && node.kind === "Binary" && node.op === "*") {
    return [...collectNumericMultiplyFactors(node.left), ...collectNumericMultiplyFactors(node.right)];
  }
  const folded = foldNumeric(node);
  if (folded !== undefined) {
    return [folded];
  }
  // Identity, dynamic, and string operands contribute no numeric factor.
  return [];
};

const isHugeMultiply = (node: Record<string, unknown>): boolean => {
  const factors = collectNumericMultiplyFactors(node);
  if (factors.length === 0) {
    return false;
  }
  let product = 1;
  for (const factor of factors) {
    if (Math.abs(factor) >= HUGE_LITERAL_THRESHOLD) {
      return true;
    }
    product *= factor;
  }
  return Math.abs(product) >= HUGE_LITERAL_THRESHOLD;
};

const markHugeIfIndex = (item: unknown, findings: Findings): void => {
  if (isHugeFoldedNumber(item)) {
    findings.hasHugeIndexLiteral = true;
  }
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
    // setpath path segment: [999999999]
    markHugeIfIndex(item, findings);
    // delpaths nested path: [[999999999]]
    if (isRecord(item) && item.kind === "Array" && Array.isArray(item.items)) {
      for (const nested of item.items) {
        markHugeIfIndex(nested, findings);
      }
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
    if (node.op === "*=" && (isHugeFoldedNumber(node.right) || isHugeFoldedNumber(node.left))) {
      findings.hasHugeMultiply = true;
    }
  }
  if (node.kind === "Call" && (node.name === "setpath" || node.name === "delpaths")) {
    findings.hasSetpathLikeCall = true;
    markSetpathPathIndexes(node, findings);
  }
  if (node.kind === "Binary" && node.op === "*") {
    if (isHugeMultiply(node)) {
      findings.hasHugeMultiply = true;
    }
  }
  if (inAssignmentLeft && node.kind === "IndexAccess" && isHugeFoldedNumber(node.index)) {
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
