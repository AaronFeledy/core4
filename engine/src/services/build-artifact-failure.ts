import { redactProviderError } from "@lando/redaction/provider-error";
import { ArtifactBuildError } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError } from "@lando/sdk/services";
import { buildAppKind } from "./build-app-kind.ts";
import { buildFailureRemediation, buildRemediationSuffix } from "./build-remediation.ts";

export const artifactBuildFailure = (
  failure: ProviderError,
  context: {
    readonly redactor: Redactor;
    readonly plan: AppPlan;
    readonly service: string;
    readonly transcriptPath: AbsolutePath;
    readonly outputTail: string | undefined;
  },
) => {
  if (failure._tag !== "ArtifactBuildError") return redactProviderError(failure, context.redactor);
  return redactProviderError(
    new ArtifactBuildError({
      providerId: failure.providerId,
      operation: failure.operation,
      message: failure.message,
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      service: context.service,
      transcriptPath: context.transcriptPath,
      ...(context.outputTail === undefined ? {} : { outputTail: context.outputTail }),
      remediation: buildFailureRemediation(
        failure.remediation,
        buildRemediationSuffix(buildAppKind(context.plan), context.service, context.transcriptPath),
      ),
    }),
    context.redactor,
  );
};
