import { Either, Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";

import { type FileSyncStatus, SetupResultSchema } from "../core/src/cli/command-specs/meta/setup-inputs.ts";
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

export const setupFileSyncStatusFromStdout = (stdout: string): FileSyncStatus | undefined => {
  for (const line of stdout.split(/\r?\n/u)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      continue;
    }
    const envelope = Schema.decodeUnknownEither(CommandResultEnvelope)(parsed);
    if (Either.isLeft(envelope) || envelope.right.command !== "meta:setup" || !envelope.right.ok) continue;
    const result = Schema.decodeUnknownEither(SetupResultSchema)(envelope.right.result);
    if (Either.isRight(result)) return result.right.fileSyncStatus;
  }
  return undefined;
};
