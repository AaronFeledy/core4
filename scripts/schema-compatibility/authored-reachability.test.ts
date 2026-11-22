import { expect, test } from "bun:test";
import { AppPlan, CurrentExecutableAppPlan } from "@lando/sdk/schema";
import { Schema } from "effect";
import { AppliedPlan, AppliedPlans } from "../../container-runtime/src/applied-state-codec.ts";
import { PodmanComposeKnobs } from "../../container-runtime/src/podman/compose-knobs.ts";
import { EffectiveToolingPlan } from "../../engine/src/planner/effective-tooling.ts";
import { ScratchDesiredPlan } from "../../engine/src/scratch-app/plan.ts";
import { authoredDependencies } from "./authored-reachability.ts";
import { INTERNAL_PERSISTED_STORES } from "./internal-stores.ts";

// Shared value contracts are not exemptions from traversal:
// SqliteTargetConfig carries resolved target paths, without shorthand.
// RouteFilter and EndpointScan carry runtime discriminants and settings as data.
// EnvironmentValue carries literal bytes and descriptors, never Compose syntax.
// EventForSelector and EventCommandInputValue carry late invocation operands unchanged.
// ToolingFlagShape and ToolingArgShape carry literal declaration metadata, not task shorthand.
const codecs = {
  "applied per-app": AppliedPlan,
  "applied aggregate": AppliedPlans,
  "LCAP encode": AppPlan,
  "LCAP decode": CurrentExecutableAppPlan,
  "scratch plan.bin": ScratchDesiredPlan,
  "extensions.effective-tooling": EffectiveToolingPlan,
  "extensions.compose": PodmanComposeKnobs,
  ...Object.fromEntries(INTERNAL_PERSISTED_STORES.map(({ id, schema }) => [id, schema])),
};

test.each(Object.entries(codecs))("%s embeds no authored-input codec", (name, codec) => {
  expect(authoredDependencies(codec.ast, name)).toEqual([]);
});

test("detects authored input behind a composed codec and a recursive record", () => {
  const key = Schema.String.pipe(Schema.annotateEncoded({ landoAuthoredInput: "fixture" }));
  interface Tree {
    readonly children: Readonly<Record<string, Tree>>;
  }
  const tree: Schema.Codec<Tree> = Schema.suspend(() =>
    Schema.Struct({ children: Schema.Record(key, tree) }),
  );
  const wrapped = Schema.Unknown.pipe(Schema.decodeTo(tree));
  expect(authoredDependencies(wrapped.ast, "fixture")).toEqual(["fixture.children{key}: fixture"]);
});
