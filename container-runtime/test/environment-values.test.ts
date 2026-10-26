import { expect, test } from "bun:test";
import {
  EnvironmentValueResolutionError,
  PlanReplanRequiredError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import { AppPlan, CurrentExecutableAppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { containerCreateBodyFragment, mergeAppliedPlan } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { renderCompose } from "../src/podman/compose.ts";
import { ctx, fakeEngine, legacyPlan, plan, service, withService } from "./fixtures/environment-values.ts";

const bindingService = {
  ...service,
  environment: {
    TOKEN: { _tag: "SecretRef", reference: "TOKEN" },
    URL: { _tag: "BoundText", parts: ["postgres://", { reference: "TOKEN", encoding: "uri-component" }] },
    OMITTED: "not-in-complete-result",
  },
} satisfies typeof service;

test.each([true, false])(
  "existing reuse/restart running=%s never resolves creation values",
  async (running) => {
    // Given
    const desired = withService(bindingService);
    const fake = fakeEngine(desired, running);
    let resolutions = 0;
    // When
    await Effect.runPromise(
      bringUp(desired, {
        api: fake.api,
        ctx,
        resolveServiceEnvironment: () => {
          resolutions += 1;
          return Effect.die("creation resolver must not run");
        },
      }),
    );
    // Then
    expect(resolutions).toBe(0);
    expect(fake.calls.filter((call) => call.path.startsWith("/containers/create?"))).toEqual([]);
  },
);

test("creation sends the complete map, not a late overlay, and never persists resolved bytes", async () => {
  // Given
  const desired = withService(bindingService);
  const fake = fakeEngine();
  let resolutions = 0;
  // When
  await Effect.runPromise(
    bringUp(desired, {
      api: fake.api,
      ctx,
      resolveServiceEnvironment: () => {
        resolutions += 1;
        expect(fake.mutations()).toEqual([]);
        return Effect.succeed({ TOKEN: "resolved-canary", URL: "postgres://resolved-canary" });
      },
    }),
  );
  // Then
  expect(resolutions).toBe(1);
  expect(fake.calls.find((call) => call.path.startsWith("/containers/create?"))?.body).toMatchObject({
    Env: ["TOKEN=resolved-canary", "URL=postgres://resolved-canary"],
  });
  expect(JSON.stringify(desired)).not.toContain("resolved-canary");
});

test.each([false, true])(
  "resolver failure before replacement reconcile=%s preserves the container",
  async (reconcile) => {
    // Given
    const desired = withService(bindingService);
    const fake = fakeEngine(plan);
    const failure = new SecretStoreUnavailableError({
      message: "Store locked.",
      storeId: "test",
      reason: "locked",
      remediation: "Unlock.",
    });
    // When
    const error = await Effect.runPromise(
      Effect.flip(
        bringUp(desired, {
          api: fake.api,
          ctx,
          reconcile,
          resolveServiceEnvironment: () => Effect.fail(failure),
        }),
      ),
    );
    // Then
    expect(error).toBe(failure);
    expect(fake.mutations()).toEqual([]);
  },
);

test.each([false, true])(
  "legacy missing/replacement existing=%s fails before any resource mutation",
  async (existing) => {
    // Given
    const legacy = legacyPlan();
    const fake = fakeEngine(existing ? legacy : undefined);
    let resolutions = 0;
    // When
    const error = await Effect.runPromise(
      Effect.flip(
        bringUp(legacy, {
          api: fake.api,
          ctx,
          reconcile: true,
          resolveServiceEnvironment: () => {
            resolutions += 1;
            return Effect.succeed({});
          },
        }),
      ),
    );
    // Then
    expect(error).toBeInstanceOf(PlanReplanRequiredError);
    expect(resolutions).toBe(0);
    expect(fake.mutations()).toEqual([]);
  },
);

test.each(["TOKEN", "URL"])(
  "raw unresolved %s fails with safe service and variable identifiers",
  async (variable) => {
    // Given
    const desired = withService({
      ...service,
      environment: { [variable]: bindingService.environment[variable === "TOKEN" ? "TOKEN" : "URL"] },
    });
    const fake = fakeEngine();
    // When
    const error = await Effect.runPromise(Effect.flip(bringUp(desired, { api: fake.api, ctx })));
    // Then
    expect(error).toBeInstanceOf(EnvironmentValueResolutionError);
    expect(error).toMatchObject({ reason: "unresolved-binding", variable });
    expect(error.message).toContain("web");
    expect(JSON.stringify(error)).not.toContain("postgres://");
    expect(fake.mutations()).toEqual([]);
  },
);

test("direct create payload cannot bypass legacy eligibility even with a concrete environment", () => {
  // Given / When / Then
  expect(() => containerCreateBodyFragment(legacyPlan(), service, { environment: {} })).toThrow(
    PlanReplanRequiredError,
  );
});

test("direct create payload refuses unresolved descriptors", () => {
  // Given / When / Then
  expect(() => containerCreateBodyFragment(withService(bindingService), bindingService)).toThrow(
    EnvironmentValueResolutionError,
  );
});

test("resource-only legacy apply cannot create a missing volume", async () => {
  // Given
  const desired: AppPlan = {
    ...legacyPlan(),
    services: {},
    stores: [{ name: "data", scope: "app", kind: "data" }],
  };
  const calls: string[] = [];
  // When
  const error = await Effect.runPromise(
    Effect.flip(
      bringUp(desired, {
        ctx,
        api: {
          request: (request) => {
            calls.push(request.method);
            return Effect.succeed({ status: 404, body: "{}" });
          },
        },
      }),
    ),
  );
  // Then
  expect(error).toBeInstanceOf(PlanReplanRequiredError);
  expect(calls.every((method) => method === "GET")).toBe(true);
});

test("service-less legacy apply creates no network because no service joins one", async () => {
  // Given
  const desired: AppPlan = { ...legacyPlan(), services: {}, stores: [] };
  const calls: string[] = [];
  // When
  const result = await Effect.runPromise(
    bringUp(desired, {
      ctx,
      api: {
        request: (request) => {
          calls.push(`${request.method} ${request.path}`);
          return Effect.succeed({ status: 404, body: "{}" });
        },
      },
    }),
  );
  // Then
  expect(result.changed).toBe(false);
  expect(calls.filter((call) => call.includes("/networks"))).toEqual([]);
});

test("resource-only legacy reuse observes existing volumes without recreating them", async () => {
  // Given
  const desired: AppPlan = {
    ...legacyPlan(),
    services: {},
    stores: [{ name: "data", scope: "app", kind: "data" }],
  };
  const calls: string[] = [];
  // When
  await Effect.runPromise(
    bringUp(desired, {
      ctx,
      api: {
        request: (request) => {
          calls.push(request.method);
          return Effect.succeed({ status: 200, body: "{}" });
        },
      },
    }),
  );
  // Then
  expect(calls.every((method) => method === "GET")).toBe(true);
});

test("legacy observation retains identity and literal environment without granting execution eligibility", async () => {
  // Given
  const legacy = {
    ...legacyPlan(),
    services: { [service.name]: { ...service, environment: { TOKEN: "${secret:TOKEN}" } } },
  };
  // When
  const observed = Schema.decodeUnknownSync(AppPlan)(Schema.encodeSync(AppPlan)(legacy));
  const fake = fakeEngine(observed);
  await Effect.runPromise(bringUp(observed, { api: fake.api, ctx }));
  // Then
  expect(observed.id).toBe(legacy.id);
  expect(observed.root).toBe(legacy.root);
  expect(observed.services[service.name]?.environment.TOKEN).toBe("${secret:TOKEN}");
  expect(observed).not.toHaveProperty("valueModel");
  expect(() =>
    Schema.decodeUnknownSync(CurrentExecutableAppPlan)(Schema.encodeSync(AppPlan)(observed)),
  ).toThrow();
  expect(fake.mutations()).toEqual([]);
});

test("partial apply cannot certify retained legacy services", () => {
  // Given
  const retained = { ...service, name: ServiceName.make("old") };
  const previous = { ...legacyPlan(), services: { [retained.name]: retained } };
  // When
  const merged = mergeAppliedPlan(previous, plan, false);
  // Then
  expect(merged.services[retained.name]).toBe(retained);
  expect(merged).not.toHaveProperty("valueModel");
  expect(() => containerCreateBodyFragment(merged, retained)).toThrow(PlanReplanRequiredError);
  expect(mergeAppliedPlan(previous, plan, true).valueModel).toBe(1);
  expect(mergeAppliedPlan(legacyPlan(), plan, false).valueModel).toBe(1);
});

test("compose preview explicitly lowers typed descriptors as quoted data without lookup", () => {
  // Given
  const desired = withService(bindingService);
  // When
  const yaml = renderCompose(desired, ctx);
  const document = Bun.YAML.parse(yaml);
  // Then
  expect(document).toMatchObject({
    services: {
      web: {
        environment: {
          TOKEN: JSON.stringify(bindingService.environment.TOKEN),
          URL: JSON.stringify(bindingService.environment.URL),
        },
      },
    },
  });
  expect(yaml).not.toContain("[object Object]");
});
