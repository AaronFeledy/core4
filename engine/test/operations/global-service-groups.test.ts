import { describe, expect, test } from "bun:test";
import { ServiceStartError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ApplyOptions, RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit } from "effect";
import {
  applyGlobalServiceGroups,
  globalServiceGroupError,
} from "../../src/operations/global-service-groups.ts";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../../src/providers/managed.ts";

const service = (name: string, dependencies: ReadonlyArray<string> = []): ServicePlan => ({
  type: "test",
  provider: MANAGED_PROVIDER_SELECT_PLAN.provider,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  hostAliases: [],
  metadata: MANAGED_PROVIDER_SELECT_PLAN.metadata,
  extensions: {},
  name: ServiceName.make(name),
  artifact: { kind: "ref", ref: `unbuilt:${name}` },
  dependsOn: dependencies.map((name) => ({
    service: ServiceName.make(name),
    condition: "service_started",
    required: true,
  })),
});
const planWith = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  ...MANAGED_PROVIDER_SELECT_PLAN,
  services: Object.fromEntries(services.map((service) => [service.name, service])),
});
const build = (plan: AppPlan) =>
  Effect.succeed({
    ...plan,
    services: Object.fromEntries(
      Object.values(plan.services).map((service) => [
        service.name,
        { ...service, artifact: { kind: "ref" as const, ref: `built:${service.name}` } },
      ]),
    ),
  });
const failure = (name: string, remediation?: string) =>
  new ServiceStartError({
    service: name,
    providerId: "lando",
    operation: "apply",
    message: `Cannot start ${name}`,
    ...(remediation === undefined ? {} : { remediation }),
  });
const refs = (plan: AppPlan) => Object.values(plan.services).map((service) => service.artifact);

describe("global service groups", () => {
  test("an empty selection leaves the plan unchanged without building or applying", async () => {
    // Given a plan with no selected services and callbacks that must not run.
    const plan = planWith([service("unselected")]);
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: () => Effect.die(new Error("Unexpected apply")),
    };
    // When no service groups are selected.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(plan, { provider, services: [], options: { reconcile: false } }, () =>
        Effect.die(new Error("Unexpected build")),
      ),
    );
    // Then the original plan is returned with no successes or failures.
    expect(outcome.builtPlan).toBe(plan);
    expect(outcome.services).toEqual([]);
    expect(outcome.failures).toEqual([]);
  });

  test("groups reverse edges and transitive dependencies in plan order", async () => {
    // Given interleaved independent services and a reverse, transitive chain.
    const plan = planWith([service("a"), service("solo"), service("c", ["b"]), service("b", ["a"])]);
    const applied: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          applied.push(Object.keys(plan.services));
          return { changed: true };
        }),
    };
    // When the groups are built and applied.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then connectivity is undirected and every group preserves plan order.
    expect(applied).toEqual([["a", "c", "b"], ["solo"]]);
    expect(outcome.services.map((service) => String(service.name))).toEqual(["a", "solo", "c", "b"]);
    expect(outcome.failures).toEqual([]);
  });

  test("a build failure does not prevent another group from starting", async () => {
    // Given an independent group whose build fails.
    const plan = planWith([service("broken"), service("working")]);
    const error = failure("broken");
    const applied: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          applied.push(Object.keys(plan.services));
          return { changed: true };
        }),
    };
    // When all groups are attempted.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        (plan) =>
          plan.services[ServiceName.make("broken")] === undefined ? build(plan) : Effect.fail(error),
      ),
    );
    // Then the original build error is retained and only the built group is applied.
    expect(outcome.failures).toEqual([{ names: [ServiceName.make("broken")], error }]);
    expect(outcome.failures[0]?.error).toBe(error);
    expect(applied).toEqual([["working"]]);
    expect(outcome.services.map((service) => String(service.name))).toEqual(["working"]);
  });

  test("every group failing returns an outcome with the first original error unchanged", async () => {
    // Given two groups that fail with different original errors.
    const plan = planWith([service("first"), service("second")]);
    const first = failure("first");
    const second = failure("second");
    const attempts: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          attempts.push(Object.keys(plan.services));
        }).pipe(
          Effect.andThen(
            Effect.fail(plan.services[ServiceName.make("first")] === undefined ? second : first),
          ),
        ),
    };
    // When both applies fail.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then reconciliation receives every failure and no aggregate replaces the first error.
    expect(outcome.services).toEqual([]);
    expect(outcome.failures).toEqual([
      { names: [ServiceName.make("first")], error: first },
      { names: [ServiceName.make("second")], error: second },
    ]);
    expect(globalServiceGroupError("start", outcome)).toBe(first);
    expect(attempts).toEqual([["first"], ["second"]]);
  });

  test.each([
    ["build", "interruption"],
    ["apply", "interruption"],
    ["build", "defect"],
    ["apply", "defect"],
  ] as const)("%s %s propagates without attempting later groups", async (stage, kind) => {
    // Given a first group that interrupts or defects at the selected stage.
    const plan = planWith([service("first"), service("second")]);
    const fatal = kind === "interruption" ? Effect.interrupt : Effect.die(new Error("group defect"));
    const attempts: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: () => (stage === "apply" ? fatal : Effect.succeed({ changed: true })),
    };
    // When groups execute.
    const exit = await Effect.runPromiseExit(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        (plan) =>
          Effect.sync(() => {
            attempts.push(Object.keys(plan.services));
          }).pipe(Effect.andThen(stage === "build" ? fatal : build(plan))),
      ),
    );
    // Then the fatal cause retains its class and later groups are not started.
    expect(
      Exit.isFailure(exit) &&
        (kind === "interruption" ? Cause.hasInterruptsOnly(exit.cause) : Cause.hasDies(exit.cause)),
    ).toBe(true);
    expect(attempts).toEqual([["first"]]);
  });

  test("non-reconcile selected start preserves previously built unselected services", async () => {
    // Given a loaded unbuilt plan and an existing built record.
    const selected = service("mailpit");
    const plan = planWith([selected, service("traefik")]);
    let recorded = await Effect.runPromise(build(plan));
    const optionsSeen: ApplyOptions[] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan, options) =>
        Effect.sync(() => {
          optionsSeen.push(options);
          const incoming = options.recordedPlan ?? plan;
          recorded = { ...incoming, services: { ...recorded.services, ...incoming.services } };
          return { changed: true };
        }),
    };
    // When only mailpit starts without reconciliation.
    await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: [selected],
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then the provider receives no unbuilt full-plan override.
    expect(optionsSeen[0]).not.toHaveProperty("recordedPlan");
    expect(refs(recorded)).toEqual([
      { kind: "ref", ref: "built:mailpit" },
      { kind: "ref", ref: "built:traefik" },
    ]);
  });

  test("reconcile applies cumulative built plans when each apply replaces the record", async () => {
    // Given independent services whose recorded plan is replaced on each apply.
    const plan = planWith([service("mailpit"), service("traefik")]);
    const records: AppPlan[] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan, options) =>
        Effect.sync(() => {
          records.push(options.recordedPlan ?? plan);
          return { changed: true };
        }),
    };
    // When reconciliation applies both groups.
    await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: true },
        },
        build,
      ),
    );
    // Then the later record retains earlier built entries and the full service set.
    expect(records.map(refs)).toEqual([
      [
        { kind: "ref", ref: "built:mailpit" },
        { kind: "ref", ref: "unbuilt:traefik" },
      ],
      [
        { kind: "ref", ref: "built:mailpit" },
        { kind: "ref", ref: "built:traefik" },
      ],
    ]);
  });

  test("partial error inherits tagged remediation with singular and plural agreement", () => {
    // Given one failed group and several running services.
    const cause = failure("ssh-agent", "Repair the bind source.");
    // When the aggregate is constructed.
    const error = globalServiceGroupError("start", {
      services: [service("mailpit"), service("traefik"), service("traefik-diagnostics")],
      failures: [{ names: ["ssh-agent"], error: cause }],
    });
    // Then the remediation is dedupe-friendly and the cause remains intact.
    expect(error?.message).toBe(
      "Global service ssh-agent failed to start; mailpit, traefik, traefik-diagnostics are running.",
    );
    expect(error?.remediation).toBe("Repair the bind source.");
    expect(error?.cause).toBe(cause);
  });

  test("no failures produce no aggregate error", () => {
    // Given a successful service outcome.
    const outcome = { services: [service("working")], failures: [] };
    // When an aggregate error is requested.
    const error = globalServiceGroupError("start", outcome);
    // Then success is not reported as a partial failure.
    expect(error).toBeUndefined();
  });

  test.each([
    [
      "start",
      "Fix the error above, then run `lando global:start` to retry the global services. Run `lando doctor` if the failure persists.",
    ],
    [
      "rebuild",
      "Fix the error above, then run `lando global:rebuild`. Run `lando doctor` if the failure persists.",
    ],
  ] as const)("partial %s errors use operation-specific fallback remediation", (operation, remediation) => {
    // Given multiple failed services without tagged remediation and one running service.
    const cause = failure("broken");
    // When the aggregate is constructed for the selected operation.
    const error = globalServiceGroupError(operation, {
      services: [service("working")],
      failures: [{ names: ["broken", "dependent"], error: cause }],
    });
    // Then fallback instructions match the operation and grammar matches the service counts.
    expect(error?.remediation).toBe(remediation);
    expect(error?.message).toBe(
      `Global services broken, dependent failed to ${operation}; working is running.`,
    );
    expect(error?.cause).toBe(cause);
  });
});
