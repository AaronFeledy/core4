import { AppliedStateVersionError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, InfoAppliedStateIssue } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";

const hasStatePath = Schema.is(Schema.Struct({ path: Schema.String }));

export const isSameInfoAppliedStateFailure = (
  failure: unknown,
  issue: InfoAppliedStateIssue,
  provider: string,
) =>
  issue.reason === "newer-version"
    ? failure instanceof AppliedStateVersionError &&
      failure.providerId === provider &&
      failure.path === issue.path
    : failure instanceof ProviderUnavailableError &&
      failure.providerId === provider &&
      failure.operation === "applied-state.read" &&
      hasStatePath(failure.details) &&
      failure.details.path === issue.path;

export const observeInfoAppliedState = Effect.fnUntraced(function* (plan: AppPlan, kind: AppRef["kind"]) {
  const registry = yield* RuntimeProviderRegistry;
  const root = plan.identity?.appRoot ?? plan.root;
  const strict = yield* Effect.result(
    registry.readAppliedPlanStrict({ id: plan.id, provider: plan.provider }),
  );
  if (Result.isSuccess(strict)) {
    const observed = yield* registry.resolveAppliedPlan(root, { kind, id: plan.id }, "exact");
    const applied = strict.success ?? observed;
    return {
      applied: (applied?.identity?.appRoot ?? applied?.root) === root ? applied : undefined,
      appliedStateIssue: undefined,
    };
  }
  const failure = strict.failure;
  switch (failure._tag) {
    case "AppliedStateVersionError":
      return {
        applied: undefined,
        appliedStateIssue: {
          reason: "newer-version",
          path: failure.path,
          message: failure.message,
          remediation: failure.remediation,
          storedVersion: failure.storedVersion,
          supportedVersion: failure.supportedVersion,
          ...(failure.writtenBy === undefined ? {} : { writtenBy: failure.writtenBy }),
        } satisfies InfoAppliedStateIssue,
      };
    case "ProviderUnavailableError":
      if (!failure.operation.startsWith("applied-state.") || !hasStatePath(failure.details)) {
        return yield* Effect.fail(failure);
      }
      return {
        applied: undefined,
        appliedStateIssue: {
          reason: "unreadable",
          path: failure.details.path,
          message: failure.message,
          remediation: failure.remediation,
        } satisfies InfoAppliedStateIssue,
      };
    case "NoProviderInstalledError":
      return yield* Effect.fail(failure);
    default:
      return failure satisfies never;
  }
});
