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

test.each(resolvers)("%s refuses legacy double state with a usable rename recovery", async (resolve) => {
  const error = await Effect.runPromise(
    resolve(plan.root, [
      { ...TestRuntimeProvider, id: "lando", appliedPlans: Effect.succeed([old, renamed]) },
    ]).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(AppResolveError);
  if (!(error instanceof AppResolveError)) throw error;
  expect(error.reason).toBe("ambiguous");
  expect(error.message).toContain(plan.root);
  expect(error.message).toContain(old.name);
  expect(error.message).toContain(renamed.name);
  expect(error.remediation).toContain("`lando start`");
  expect(error.remediation).not.toContain("lando destroy");
});

test.each(resolvers)(
  "%s preserves provider-scoped recovery for genuinely different providers",
  async (resolve) => {
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
    expect(error.message).toContain("lando, docker");
    expect(error.message).not.toContain("lando, lando");
    expect(error.remediation).toContain("lando destroy --provider=lando --yes");
    expect(error.remediation).toContain("lando destroy --provider=docker --yes");
  },
);
