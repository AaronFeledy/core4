import { expect, test } from "bun:test";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
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

test.each([
  { change: "reference", before: { ref: "built:first" }, after: { ref: "built:second" } },
  {
    change: "digest",
    before: { ref: "built:latest", digest: `sha256:${"a".repeat(64)}` },
    after: { ref: "built:latest", digest: `sha256:${"b".repeat(64)}` },
  },
])("recreates an independently lowered artifact when its $change changes", async ({ before, after }) => {
  // Given a container built from one realization of unchanged authored intent.
  const engine = fakeEngine();
  const first = retainCreateArtifactIdentity(service, {
    ...service,
    artifact: { kind: "ref", ...before },
  });
  await Effect.runPromise(bringUp(withService(first), { api: engine.api, ctx }));
  const next = retainCreateArtifactIdentity(service, {
    ...service,
    artifact: { kind: "ref", ...after },
  });

  // When a later build produces a different realization of that same intent.
  await Effect.runPromise(bringUp(withService(next), { api: engine.api, ctx }));

  // Then normal apply replaces the old container with the newly built image.
  const creates = engine.calls.filter((call) => call.path.startsWith("/containers/create?"));
  expect(creates).toHaveLength(2);
  expect(creates.map((call) => call.body)).toMatchObject([{ Image: before.ref }, { Image: after.ref }]);
});

test("independent lowering to the same artifact reuses without creation resolution", async () => {
  // Given independently lowered plans with equal provenance, ref, and digest.
  const lower = () =>
    retainCreateArtifactIdentity(service, {
      ...service,
      artifact: { kind: "ref", ref: "built:same", digest: "sha256:same" },
    });
  const engine = fakeEngine(withService(lower()));
  // When ordinary apply sees the identical realization.
  await Effect.runPromise(
    bringUp(withService(lower()), {
      api: engine.api,
      ctx,
      resolveServiceEnvironment: () => Effect.die("reuse must not resolve creation values"),
    }),
  );
  // Then no container or resource mutation occurs.
  expect(engine.mutations()).toEqual([]);
});

test("artifact-only replacement resolver failure preserves containers and resources", async () => {
  // Given unchanged intent lowered to a new artifact and a locked creation resolver.
  const first = retainCreateArtifactIdentity(service, {
    ...service,
    artifact: { kind: "ref", ref: "built:first" },
  });
  const next = retainCreateArtifactIdentity(service, {
    ...service,
    artifact: { kind: "ref", ref: "built:next" },
  });
  const engine = fakeEngine(withService(first));
  const desired = {
    ...withService(next),
    stores: [{ name: "data", scope: "app", kind: "data" }],
  } satisfies ReturnType<typeof withService>;
  const failure = new SecretStoreUnavailableError({
    message: "Locked.",
    storeId: "test",
    reason: "locked",
    remediation: "Unlock.",
  });
  let resolutions = 0;
  // When replacement must resolve creation values before any resource or stop action.
  const error = await Effect.runPromise(
    Effect.flip(
      bringUp(desired, {
        api: engine.api,
        ctx,
        resolveServiceEnvironment: () => {
          resolutions += 1;
          return Effect.fail(failure);
        },
      }),
    ),
  );
  // Then artifact drift is detected but no destructive or resource action is dispatched.
  expect(error).toBe(failure);
  expect(resolutions).toBe(1);
  expect(engine.mutations()).toEqual([]);
});
