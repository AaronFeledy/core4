import { Result, Schema } from "effect";

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
    const decoded = Schema.decodeUnknownResult(FailureEvidenceSchema)(parsed);
    if (Result.isSuccess(decoded) && decoded.success.imagePull !== undefined)
      return decoded.success.imagePull;
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
    const envelope = Schema.decodeUnknownResult(CommandResultEnvelope)(parsed);
    if (Result.isFailure(envelope) || envelope.success.command !== "meta:setup" || !envelope.success.ok)
      continue;
    const result = Schema.decodeUnknownResult(SetupResultSchema)(envelope.success.result);
    if (Result.isSuccess(result)) return result.success.fileSyncStatus;
  }
  return undefined;
};
