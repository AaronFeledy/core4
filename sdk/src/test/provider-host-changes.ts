import { Effect, Schema } from "effect";
import { mapFailures } from "../command-result/failure.ts";
import { HostChange } from "../schema/host-change.ts";
import type { RuntimeProviderShape } from "../services/index.ts";
import { mapProviderFailure, requireContract } from "./_shared.ts";

/**
 * A provider's host-change proposals are well formed: schema-valid changes, each id and step
 * declared once, and every privileged step naming an absolute program. Planning is read-only by
 * contract, so the suite only inspects what it returns; the engine's applier enforces that apply
 * runs declared steps only.
 */
export const checkHostChangeProposals = Effect.fnUntraced(function* (provider: RuntimeProviderShape) {
  if (provider.planHostChanges === undefined) return;
  const proposals = yield* provider
    .planHostChanges({ force: false })
    .pipe(mapFailures(mapProviderFailure("planHostChanges returns host-change proposals")));
  const ids = new Set<string>();
  for (const { change, apply } of proposals) {
    yield* requireContract(
      Schema.is(HostChange)(change),
      "planHostChanges returns schema-valid host changes",
      change,
    );
    yield* requireContract(!ids.has(change.id), "planHostChanges declares each change id once", change.id);
    ids.add(change.id);
    const stepIds = change.steps.map((step) => step.id);
    yield* requireContract(
      new Set(stepIds).size === stepIds.length,
      "a host change declares each step once",
      stepIds,
    );
    yield* requireContract(
      change.steps.every((step) => !step.privileged || step.argv[0].startsWith("/")),
      "privileged host-change steps name absolute programs",
      change.steps,
    );
    yield* requireContract(typeof apply === "function", "a host-change proposal carries apply", change.id);
  }
});
