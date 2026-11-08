import { expect, test } from "bun:test";
import { AppResolveError } from "@lando/sdk/errors";
import { AppId, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import type { AbsolutePath } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import type { AppliedStateProvider } from "../../src/providers/applied-state-resolution.ts";
import {
  resolveAppliedPlanEvidence,
  resolveTeardownEvidence,
} from "../../src/providers/applied-state-resolution.ts";
import { plan } from "../operations/start-progress-topology-support.ts";

const old = { ...plan, identity: { appRoot: plan.root, ownerKey: appIdentityKey("owner", plan.root) } };
const renamed = { ...old, id: AppId.make("new-name"), name: "new-name" };
const resolvers = [
  (root: AbsolutePath, providers: readonly AppliedStateProvider[]) =>
    resolveAppliedPlanEvidence(root, providers).pipe(Effect.asVoid),
  (root: AbsolutePath, providers: readonly AppliedStateProvider[]) =>
    resolveTeardownEvidence(root, providers).pipe(Effect.asVoid),
];

test.each(resolvers)("%s refuses legacy double state without a desired app id", async (resolve) => {
  const error = await Effect.runPromise(
    resolve(plan.root, [
      { ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([old, renamed]) },
    ]).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(AppResolveError);
  if (!(error instanceof AppResolveError)) throw error;
  expect(error.reason).toBe("ambiguous");
  expect(error.detail).toBe("applied-state");
});

test("observation selects the authored app id from legacy double state", async () => {
  const selected = await Effect.runPromise(
    resolveAppliedPlanEvidence(
      plan.root,
      [{ ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([old, renamed]) }],
      { kind: "user", id: renamed.id },
    ),
  );
  expect(selected?.id).toBe(renamed.id);
});

test.each([
  ...resolvers,
  (root: AbsolutePath, providers: readonly AppliedStateProvider[]) =>
    resolveAppliedPlanEvidence(root, providers, { kind: "user", id: renamed.id }).pipe(Effect.asVoid),
])("%s preserves provider-scoped recovery for genuinely different providers", async (resolve) => {
  const error = await Effect.runPromise(
    resolve(plan.root, [
      { ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([old, renamed]) },
      {
        ...TestRuntimeProvider,
        id: "docker",
        appliedPlans: Effect.succeed([{ ...renamed, provider: ProviderId.make("docker") }]),
      },
    ]).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(AppResolveError);
  if (!(error instanceof AppResolveError)) throw error;
  expect(error.reason).toBe("ambiguous");
  expect(error.detail).toBe("applied-state");
});
