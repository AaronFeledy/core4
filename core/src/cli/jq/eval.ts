import { JqExpressionError } from "@lando/sdk/errors";

import { redactString } from "../redact.ts";
import type { JqEngine } from "./types.ts";

export const JQ_EVAL_TIMEOUT_MS = 5000;
export const JQ_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const EVAL_REMEDIATION = "Fix the jq expression.";
const TIMEOUT_REMEDIATION = "Simplify the jq expression.";
const TOO_LARGE_REMEDIATION = "Narrow the jq expression so the result is smaller.";

let defaultEngine: Promise<JqEngine> | undefined;

const loadDefaultEngine = (): Promise<JqEngine> => {
  defaultEngine ??= import("./jq-wasm-engine.ts").then((mod) => mod.jqWasmEngine);
  return defaultEngine;
};

export const applyJqToRedactedJsonLine = async (
  line: string,
  expr: string,
  engine?: JqEngine,
): Promise<string> => {
  const input = parseJsonLine(line, expr);
  const resolved = engine ?? (await loadDefaultEngine());
  const { text } = await evalWithTimeout(resolved, input, expr);
  assertOutputSize(text, expr);
  const formatted = formatEngineText(text);
  assertOutputSize(formatted, expr);
  return formatted;
};

const parseJsonLine = (line: string, expr: string): unknown => {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw jqEvalError(expr, error.message);
    }
    throw error;
  }
};

const evalWithTimeout = async (engine: JqEngine, input: unknown, expr: string): Promise<{ text: string }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new JqExpressionError({
          message: "jq expression timed out.",
          expression: expr,
          reason: "timeout",
          remediation: TIMEOUT_REMEDIATION,
        }),
      );
    }, JQ_EVAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([settleEngine(engine, input, expr), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const settleEngine = async (engine: JqEngine, input: unknown, expr: string): Promise<{ text: string }> => {
  try {
    return await engine.eval(input, expr);
  } catch (error) {
    if (error instanceof JqExpressionError) {
      throw error;
    }
    throw jqEvalError(expr, error);
  }
};

const formatEngineText = (text: string): string => {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const parsed = parseJsonValue(trimmed);
  if (parsed !== undefined) {
    return formatJqValue(parsed);
  }
  const lines = trimmed.split("\n");
  if (lines.length === 1) {
    return trimmed;
  }
  return lines
    .map((line) => {
      const value = parseJsonValue(line);
      return value === undefined ? line : formatJqValue(value);
    })
    .join("\n");
};

const parseJsonValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
};

const formatJqValue = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value === null ? "null" : String(value);
  }
  return JSON.stringify(value);
};

const assertOutputSize = (text: string, expr: string): void => {
  if (Buffer.byteLength(text, "utf8") <= JQ_MAX_OUTPUT_BYTES) {
    return;
  }
  throw new JqExpressionError({
    message: "jq expression result is too large.",
    expression: expr,
    reason: "too_large",
    remediation: TOO_LARGE_REMEDIATION,
  });
};

const jqEvalError = (expr: string, cause: unknown): JqExpressionError => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const detail = redactString(raw);
  return new JqExpressionError({
    message: "jq expression failed.",
    expression: expr,
    reason: "eval",
    remediation: EVAL_REMEDIATION,
    detail,
  });
};
