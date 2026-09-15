import { Effect } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { writeDiagnosticLine } from "@lando/renderer/output";

const FAILURE_FIELDS = ["_tag", "name", "message", "remediation", "providerId", "operation", "kind"] as const;
const DETAIL_FIELDS = ["status", "body", "method", "path", "reference", "error", "failureKind"] as const;
const MAX_CAUSE_DEPTH = 8;

const scalarFields = (
  value: object,
  keys: readonly string[],
): Readonly<Record<string, string | number | boolean>> =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const field = Reflect.get(value, key);
      return typeof field === "string" || typeof field === "number" || typeof field === "boolean"
        ? [[key, field]]
        : [];
    }),
  );

const taggedCauseEvidence = (error: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const fields = scalarFields(current, FAILURE_FIELDS);
    const details = Reflect.get(current, "details");
    chain.push({
      ...fields,
      ...(typeof details === "object" && details !== null
        ? { details: scalarFields(details, DETAIL_FIELDS) }
        : {}),
    });
    current = Reflect.get(current, "cause");
  }
  return chain;
};

export const renderFailureEvidence = (error: unknown) => {
  if (process.env.LANDO_DEBUG_CAUSE_CHAIN !== "1") return Effect.succeed(error);
  return Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("telemetry", { sourceEnv: process.env });
    const evidence = JSON.stringify(redactor.redactValue(taggedCauseEvidence(error)));
    yield* writeDiagnosticLine(`failure-cause-evidence ${evidence}`);
    return error;
  });
};
