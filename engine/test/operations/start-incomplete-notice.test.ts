import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
  type ServiceRunObservation,
} from "@lando/sdk/schema";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeFields,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import {
  type IncompleteStartCommand,
  markStartMutation,
  withIncompleteStartNotice,
} from "../../src/operations/start-incomplete-notice.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  source: "start-incomplete-notice.test",
  runtime: 4 as const,
};
const service = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary: false,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});
const plan: AppPlan = {
  id: AppId.make("notice"),
  name: "notice",
  slug: "notice",
  root: AbsolutePath.make("/tmp/lando-notice"),
  provider: providerId,
  services: Object.fromEntries(
    ["web", "db", "worker", "cache", "gone"].map((name) => [ServiceName.make(name), service(name)]),
  ),
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

type Observed = (Partial<ServiceRuntimeFields> & ServiceRunObservation) | "fails" | "hangs" | "defects";

const runtimeFor = (
  name: string,
  observed: Partial<ServiceRuntimeFields> & ServiceRunObservation,
): ServiceRuntimeInfo => ({
  app: plan.id,
  service: ServiceName.make(name),
  providerId,
  publications: { status: "unknown" },
  ...observed,
});

const makeRegistry = (observations: Readonly<Record<string, Observed>>, inspected: string[]) => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: (target) => {
      const name = String(target.service);
      inspected.push(name);
      const observed = observations[name] ?? { status: "absent" as const };
      if (observed === "defects") return Effect.die("inspect defect");
      if (observed === "hangs") return Effect.never;
      if (observed === "fails")
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "inspect",
            message: "down",
            remediation: "Install or start the `lando` provider and confirm it can perform `inspect`.",
          }),
        );
      return Effect.succeed(runtimeFor(name, observed));
    },
  };
  return RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
  });
};

const failing = Effect.fail("start failed" as const);
const mutated = markStartMutation(plan);

const run = <A, E>(
  effect: Effect.Effect<A, E>,
  options: {
    readonly observations?: Readonly<Record<string, Observed>>;
    readonly machineOutput?: boolean;
    readonly command?: IncompleteStartCommand;
  } = {},
) => {
  const warnings = makeCommandWarnings(options.machineOutput ?? false);
  const inspected: string[] = [];
  return Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withIncompleteStartNotice(effect, options.command ?? { verb: "start" }),
      );
      return { exit, notices: yield* warnings.failureNotices, inspected };
    }).pipe(
      Effect.provideService(CommandWarnings, warnings),
      Effect.provideService(RuntimeProviderRegistry, makeRegistry(options.observations ?? {}, inspected)),
    ),
  );
};

describe("incomplete start notice", () => {
  test("a successful start adds no notice", async () => {
    // Given / When: a start that mutates and succeeds.
    const { exit, notices } = await run(mutated.pipe(Effect.as("ok")));
    // Then: nothing is reported.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(notices).toEqual([]);
  });

  test("target resolution failure without a plan says no app resources changed", async () => {
    // Given / When: target resolution fails before producing a plan or marking a mutation.
    const { exit, notices, inspected } = await run(
      failing.pipe(Effect.as(plan), Effect.flatMap(markStartMutation)),
    );
    // Then: the primary failure is unchanged and nothing is observed.
    expect(Exit.isFailure(exit)).toBe(true);
    expect(inspected).toEqual([]);
    expect(notices).toEqual([
      "Start did not complete. No app resources changed. Fix the reported error, then run `lando start`.",
    ]);
  });

  test("a selected rebuild names the command that was run", async () => {
    // Given / When: rebuild of one service fails before it changes anything.
    const { notices } = await run(failing.pipe(Effect.as(plan), Effect.flatMap(markStartMutation)), {
      command: { verb: "rebuild", services: ["web"] },
    });
    // Then: the notice names rebuild and that service, not start.
    expect(notices).toEqual([
      "Rebuild did not complete. No app resources changed. Fix the reported error, then run `lando rebuild -s web`.",
    ]);
  });

  test.each(["created", "paused", "exited", "dead"] as const)(
    "classifies known %s alongside running and unverified services",
    async (status) => {
      // Given: one running, one created, one stopped, one unobservable, and one missing container.
      const observations = {
        web: { status: "running", containerId: "web-id" },
        db: { status: "exited", containerId: "db-id" },
        worker: { status, containerId: "worker-id" },
        cache: "fails",
        gone: { status: "absent" },
      } as const;
      // When: the start fails after it began changing app resources.
      const { exit, notices } = await run(mutated.pipe(Effect.andThen(failing)), { observations });
      // Then: the failure is unchanged and one notice lists what was left in place.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(notices).toEqual([
        "Start did not complete. Resources were left in place. Running: web; created/stopped: db, worker; unverified: cache. Agent forwarding/file sync remain active where established. Inspect `lando info` and `lando logs`; fix the reported error, then run `lando start`. Run `lando stop` to shut down or `lando destroy` to remove resources; named volumes require `--volumes`.",
      ]);
    },
  );

  test("an interrupted start still reports what it left in place and stays interrupted", async () => {
    // Given / When: a start interrupted after it began changing app resources.
    const { exit, notices } = await run(mutated.pipe(Effect.andThen(Effect.interrupt)), {
      observations: { web: { status: "running", containerId: "web-id" } },
    });
    // Then: interruption propagates unchanged and the notice is recorded.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(notices[0]).toContain("Running: web;");
  });

  test("machine output gets no notice and observes nothing", async () => {
    // Given / When: a failed start under JSON or YAML output.
    const { notices, inspected } = await run(mutated.pipe(Effect.andThen(failing)), {
      machineOutput: true,
    });
    // Then: the envelope stays unchanged.
    expect(notices).toEqual([]);
    expect(inspected).toEqual([]);
  });

  test.each([false, true])(
    "a nested start reports once and retains the first full plan (outer mark=%s)",
    async (outer) => {
      // Given: a restart-like operation whose inner start marks the mutation and fails.
      const subset = { ...plan, services: { web: service("web") } };
      const inner = withIncompleteStartNotice(
        markStartMutation(outer ? subset : plan).pipe(Effect.andThen(failing)),
        { verb: "start" },
      );
      // When: the outer operation fails with it.
      const { notices, inspected } = await run((outer ? mutated : Effect.void).pipe(Effect.andThen(inner)));
      // Then: exactly one notice reflects the inner mutation.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Resources were left in place.");
      expect(inspected).toEqual(["web", "db", "worker", "cache", "gone"]);
    },
  );

  test("library callers without a command warning sink are unaffected", async () => {
    // Given / When: a failed start outside the CLI.
    const exit = await Effect.runPromiseExit(
      withIncompleteStartNotice(mutated.pipe(Effect.andThen(failing)), { verb: "start" }).pipe(Effect.scoped),
    );
    // Then: the failure is unchanged.
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test.each([
    ["unknown", "web-id", "unverified: web."],
    ["removing", "web-id", "unverified: web."],
    ["unknown", undefined, "unverified: web."],
    ["absent", undefined, "unverified: none."],
    ["restarting", "web-id", "Running: web (restarting);"],
  ] as const)("does not report %s as stopped", async (status, containerId, expected) => {
    // Given / When: an observed container whose state is not stopped.
    const { notices } = await run(mutated.pipe(Effect.andThen(failing)), {
      observations: { web: { status, ...(containerId === undefined ? {} : { containerId }) } },
    });
    // Then: only positively classified states are reported as stopped.
    expect(notices[0]).toContain("created/stopped: none;");
    expect(notices[0]).toContain(expected);
  });

  test.each([false, true])(
    "inspection defects preserve the primary cause (interrupt=%s)",
    async (interrupted) => {
      // Given: a primary failure or interruption followed by a broken inspection.
      const original = interrupted ? Cause.interrupt(123) : Cause.fail("start failed");
      const primary = Effect.failCause(original);
      // When: inventory runs after mutation.
      const { exit, notices } = await run(mutated.pipe(Effect.andThen(primary)), {
        observations: { web: "defects", db: { status: "running", containerId: "db-id" } },
      });
      // Then: no inventory defect contaminates the primary failure or loses healthy observations.
      expect(exit).toEqual(Exit.failCause(original));
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(interrupted);
      expect(notices[0]).toContain("Running: db;");
      expect(notices[0]).toContain("unverified: web.");
    },
  );

  test.each(["immediate", "slow", "hanging"])(
    "bounds %s provider selection and inspection by one total second",
    async (mode) => {
      // Given: selection consumes part or all of the inventory budget; db never answers.
      const warnings = makeCommandWarnings(false);
      const inspected: string[] = [];
      const registry = makeRegistry(
        {
          web: { status: "running", containerId: "w" },
          db: "hangs",
          worker: "hangs",
          cache: "hangs",
          gone: "hangs",
        },
        inspected,
      );
      // When: the test clock reaches the single shared deadline.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const selection =
            mode === "hanging" ? Deferred.await(release) : Effect.sleep(mode === "slow" ? "750 millis" : 0);
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              withIncompleteStartNotice(mutated.pipe(Effect.andThen(failing)), { verb: "start" }),
            ).pipe(
              Effect.provideService(RuntimeProviderRegistry, {
                ...registry,
                select: (target) => selection.pipe(Effect.andThen(() => registry.select(target))),
              }),
            ),
          );
          yield* TestClock.adjust("999 millis");
          const early = yield* warnings.failureNotices;
          yield* TestClock.adjust("1 millis");
          const atDeadline = yield* warnings.failureNotices;
          // Release the old implementation too, so the red test fails without leaking a fiber.
          yield* Deferred.succeed(release, undefined);
          yield* TestClock.adjust("2 seconds");
          const exit = yield* Fiber.join(fiber);
          return { early, atDeadline, exit };
        }).pipe(Effect.provideService(CommandWarnings, warnings), Effect.provide(TestClock.layer())),
      );
      // Then: completed web survives, and selection never gets its own extra budget.
      expect(result.early).toEqual([]);
      expect(result.atDeadline).toHaveLength(1);
      expect(result.atDeadline[0]).toContain(
        mode === "hanging"
          ? "Running: none; created/stopped: none; unverified: web, db, worker, cache, gone."
          : "Running: web; created/stopped: none; unverified: db, worker, cache, gone.",
      );
      expect(result.exit).toEqual(await Effect.runPromiseExit(failing));
    },
  );

  test("reports a foreign-root inspect result as unverified, never running", async () => {
    // Given: provider inspect already refused ownership (no containerId, unknown state).
    const observations = {
      web: { status: "unknown", labels: { "dev.lando.app-root": "/other/app" } },
    } as const;
    // When: start fails after mutation and inventory observes that service.
    const { notices } = await run(mutated.pipe(Effect.andThen(failing)), { observations });
    // Then: the notice must not list it under Running/created/stopped.
    expect(notices[0]).toContain("Running: none;");
    expect(notices[0]).toContain("created/stopped: none;");
    expect(notices[0]).toContain("unverified: web.");
  });
});
