import { expect, test } from "bun:test";
import type { ServicePlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { CREATE_CONFIG_LABEL, retainCreateArtifactIdentity } from "../src/create-fingerprint.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { ctx, fakeEngine, service, withService } from "./fixtures/environment-values.ts";

test.each([
  "literal-${secret:TOKEN}",
  { _tag: "SecretRef", reference: "TOKEN" },
  { _tag: "BoundText", parts: ["prefix:", { reference: "TOKEN", encoding: "uri-component" }] },
] as const)(
  "creation labels use declared environment identity rather than dispatched bytes %#",
  async (value) => {
    // Given one declared value and two different complete resolver results.
    const declared: ServicePlan = { ...service, environment: { TOKEN: value } };
    const desired = withService(declared);
    const expected = commonContainerLabels(desired, declared);
    // When actual creation dispatches each complete environment through bringUp.
    const bodies = await Promise.all(
      ["first-dispatch", "second-dispatch"].map(async (resolved) => {
        const engine = fakeEngine();
        await Effect.runPromise(
          bringUp(desired, {
            api: engine.api,
            ctx,
            resolveServiceEnvironment: () => Effect.succeed({ TOKEN: resolved }),
          }),
        );
        return engine.calls.find((call) => call.path.startsWith("/containers/create?"))?.body;
      }),
    );
    // Then both requests carry the descriptor-derived label while dispatch bytes differ.
    expect(bodies[0]).toMatchObject({ Labels: expected, Env: ["TOKEN=first-dispatch"] });
    expect(bodies[1]).toMatchObject({ Labels: expected, Env: ["TOKEN=second-dispatch"] });
  },
);

test("retained source identity cannot hide a subsequent realized artifact change", () => {
  // Given source identity bound to exactly one realized artifact.
  const realized = retainCreateArtifactIdentity(service, {
    ...service,
    artifact: { kind: "ref", ref: "built:first" },
  });
  const changed = { ...realized, artifact: { kind: "ref", ref: "built:changed" } } satisfies ServicePlan;
  // When the realized artifact is changed without another lowering.
  const labels = commonContainerLabels(withService(changed), changed);
  // Then the retained identity cannot conceal that immutable change.
  expect(labels[CREATE_CONFIG_LABEL]).not.toBe(
    commonContainerLabels(withService(realized), realized)[CREATE_CONFIG_LABEL],
  );
});
