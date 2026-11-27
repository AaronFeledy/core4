import { ScratchAppError } from "@lando/sdk/errors";
import { type AbsolutePath, AppId, type AppPlan, type ResourceOwnership } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

/**
 * What a scratch reap tears down: the cached plan, else the applied plan recovered from the
 * providers, else the ownership inventories that are the scratch's only remaining record.
 */
export const resolveScratchTeardown = Effect.fn("ScratchApp.resolveTeardown")(function* (input: {
  readonly id: string;
  readonly lookupRoot: AbsolutePath;
  readonly plan?: AppPlan;
}) {
  const providers = yield* RuntimeProviderRegistry;
  const id = AppId.make(input.id);
  if (input.plan === undefined) {
    for (const provider of yield* providers.list) {
      const inventory = yield* providers.appliedStateInventory(provider);
      // The registry does not record which provider ran a scratch app, so a shared receipt
      // protects it as well as a per-app receipt that names it, even with no runtime online.
      if (inventory.unreadable.some((issue) => issue.appId === undefined || issue.appId === id))
        yield* providers.readAppliedPlanStrict({ id, provider });
    }
  }
  const teardown =
    input.plan === undefined
      ? yield* providers.resolveTeardownEvidence(input.lookupRoot, { kind: "scratch", id: input.id })
      : undefined;
  const plan = input.plan ?? (teardown?.kind === "applied" ? teardown.plan : undefined);
  if (plan !== undefined && plan.id !== input.id)
    return yield* Effect.fail(
      new ScratchAppError({
        operation: "destroy",
        message: "Cached scratch plan belongs to a different app.",
        remediation: "Repair the scratch plan cache before retrying destroy.",
      }),
    );
  if (plan !== undefined) yield* providers.readAppliedPlanStrict(plan);
  const ownership: ReadonlyArray<ResourceOwnership> =
    plan === undefined && teardown !== undefined && teardown.kind !== "absent"
      ? (teardown.ownership ?? [])
      : [];
  return { plan, ownership, inventoryOnly: plan === undefined && teardown?.kind === "owned" };
});
