import { Effect } from "effect";

import { writeDiagnosticLine } from "@lando/renderer/output";
import { FAILURE_EVIDENCE_PREFIX, failureEvidenceFor } from "./failure-diagnostic";

export const renderFailureEvidence = (error: unknown) => {
  if (process.env.LANDO_DEBUG_CAUSE_CHAIN !== "1") return Effect.succeed(error);
  return Effect.gen(function* () {
    const evidence = JSON.stringify(failureEvidenceFor(error));
    yield* writeDiagnosticLine(`${FAILURE_EVIDENCE_PREFIX}${evidence}`);
    return error;
  });
};
