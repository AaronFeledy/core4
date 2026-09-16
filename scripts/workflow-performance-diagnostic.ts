import { Either, Schema } from "effect";

import {
  FAILURE_EVIDENCE_PREFIX,
  FailureEvidenceSchema,
  type ImagePullFailureDiagnostic,
} from "../core/src/cli/failure-diagnostic.ts";

export const imagePullDiagnosticFromStderr = (stderr: string): ImagePullFailureDiagnostic | undefined => {
  for (const line of stderr.split(/\r?\n/u)) {
    const marker = line.indexOf(FAILURE_EVIDENCE_PREFIX);
    if (marker < 0) continue;
    const encoded = line.slice(marker + FAILURE_EVIDENCE_PREFIX.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      continue;
    }
    const decoded = Schema.decodeUnknownEither(FailureEvidenceSchema)(parsed);
    if (Either.isRight(decoded) && decoded.right.imagePull !== undefined) return decoded.right.imagePull;
  }
  return undefined;
};
