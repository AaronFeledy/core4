import { writeDiagnosticLine } from "@lando/renderer/output";
import { Effect } from "effect";
import { CliInvocation } from "../runtime/invocation-context";
import { FAILURE_EVIDENCE_PREFIX, failureEvidenceFor } from "./failure-diagnostic";

export const renderFailureEvidence = Effect.fnUntraced(function* (error: unknown) {
  if ((yield* CliInvocation).env.LANDO_DEBUG_CAUSE_CHAIN !== "1") return error;
  const evidence = JSON.stringify(failureEvidenceFor(error));
  yield* writeDiagnosticLine(`${FAILURE_EVIDENCE_PREFIX}${evidence}`);
  return error;
});
