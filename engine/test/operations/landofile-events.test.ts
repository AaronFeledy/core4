import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import { LandofileParseError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, EventService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { resolveLandofileEventPlan } from "../../src/operations/landofile-events.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { currentTestPlan } from "../current-plan.ts";

let root: AbsolutePath;

beforeEach(() => {
  root = AbsolutePath.make(realpathSync(mkdtempSync(join(tmpdir(), "landofile-events-"))));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const plan = (overrides: Partial<AppPlan> = {}): AppPlan => ({
  id: AppId.make("hooked"),
  name: "hooked",
  slug: "hooked",
  root,
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"), source: ".lando.yml", runtime: 4 },
  extensions: {},
  ...overrides,
});

/** What a provider hands back: the applied plan record (no events) after a JSON round trip, with no Landofile. */
const appliedTarget = ({ events: _events, ...applied }: AppPlan): ResolvedAppTarget => {
  const readBack = Schema.decodeUnknownSync(AppPlan)(
    JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(applied))),
  );
  return { plan: readBack, root: readBack.root, app: { kind: "user", id: readBack.id, root: readBack.root } };
};

const desiredSteps = { "pre-stop": ["echo from-landofile"] };

const redactionLayer = Layer.succeed(RedactionService, makeRedactionService());

const runtime = (input: {
  readonly desired?: AppPlan;
  readonly loadFailure?: LandofileParseError;
  readonly published: LandoEvent[];
  readonly redaction?: false;
}) =>
  Layer.mergeAll(
    input.redaction === false ? Layer.empty : redactionLayer,
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(LandoEventSchema)(event)) input.published.push(event);
          }),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        appliedPlansFor: () => Effect.succeed([]),
        select: () => Effect.succeed(TestRuntimeProvider),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover:
          input.loadFailure === undefined
            ? Effect.succeed(
                literalTestLandofile({ name: "hooked", services: {}, events: desiredSteps }, root),
              )
            : Effect.fail(input.loadFailure),
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: () => Effect.succeed(currentTestPlan(input.desired ?? withProjectEvents(plan(), desiredSteps))),
      }),
    ),
  );

const notices = (published: ReadonlyArray<LandoEvent>) =>
  published.flatMap((event) =>
    event._tag === "message.info" || event._tag === "message.warn" ? [[event._tag, event.body] as const] : [],
  );

describe("resolveLandofileEventPlan", () => {
  test("a desired target already carries its events and is returned as is", async () => {
    // Given
    const desired = withProjectEvents(plan(), desiredSteps);
    const target: ResolvedAppTarget = {
      plan: desired,
      root,
      app: { kind: "user", id: desired.id, root },
      landofile: literalTestLandofile({ name: "hooked", services: {} }, root),
    };
    const published: LandoEvent[] = [];

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published }))),
    );

    // Then
    expect(resolved.plan).toBe(desired);
    expect(resolved.outcome).toEqual({ status: "ran" });
    expect(published).toEqual([]);
  });

  test("an applied target runs the steps of the Landofile at its root", async () => {
    // Given the applied plan lost its events in provider state while the Landofile still has them
    writeFileSync(join(root, ".lando.yml"), "name: hooked\n");
    const target = appliedTarget(withProjectEvents(plan(), { "pre-stop": ["echo from-applied-state"] }));
    expect(target.plan.events).toBeUndefined();
    const published: LandoEvent[] = [];

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published }))),
    );

    // Then
    expect(resolved.plan.events?.["pre-stop"]?.map((step) => step.step)).toEqual(["echo from-landofile"]);
    expect(resolved.outcome).toEqual({ status: "ran" });
    expect(published).toEqual([]);
  });

  test("no Landofile at the applied root skips with an info notice", async () => {
    // Given
    const target = appliedTarget(plan());
    const published: LandoEvent[] = [];

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      ["message.info", `Skipping Landofile events for hooked: no Landofile in ${root}.`],
    ]);
    expect(resolved.outcome).toEqual({ status: "skipped", reason: `no Landofile in ${root}` });
  });

  test("a Landofile in a parent folder does not count as the applied app's Landofile", async () => {
    // Given
    writeFileSync(join(root, ".lando.yml"), "name: parent\n");
    const nested = AbsolutePath.make(join(root, "nested"));
    const target = appliedTarget(plan({ root: nested }));
    const published: LandoEvent[] = [];

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      ["message.info", `Skipping Landofile events for hooked: no Landofile in ${nested}.`],
    ]);
    expect(resolved.outcome).toEqual({ status: "skipped", reason: `no Landofile in ${nested}` });
  });

  test("a Landofile that fails to load skips with a warning that carries the reason", async () => {
    // Given
    writeFileSync(join(root, ".lando.yml"), "name: hooked\n");
    const target = appliedTarget(plan());
    const published: LandoEvent[] = [];
    const loadFailure = new LandofileParseError({
      message: "bad indentation",
      filePath: join(root, ".lando.yml"),
      line: 3,
      column: 1,
    });

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published, loadFailure }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      [
        "message.warn",
        `Skipping Landofile events for hooked: the Landofile in ${root} could not be loaded. bad indentation.`,
      ],
    ]);
    expect(resolved.outcome).toEqual({
      status: "skipped",
      reason: `the Landofile in ${root} could not be loaded. bad indentation`,
    });
  });

  test("loader text in the notice is redacted, and dropped when no redactor is available", async () => {
    // Given a loader failure that quotes an authored secret the applied plan knows about
    writeFileSync(join(root, ".lando.yml"), "name: hooked\n");
    const target = appliedTarget(
      plan({
        services: {
          [ServiceName.make("db")]: {
            name: ServiceName.make("db"),
            type: "postgres",
            provider: ProviderId.make("test"),
            primary: false,
            artifact: { kind: "ref", ref: "postgres:16" },
            environment: { DB_PASSWORD: "hunter2-secret" },
            mounts: [],
            endpoints: [],
            routes: [],
            dependsOn: [],
            hostAliases: [],
            metadata: {
              resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
              source: ".lando.yml",
              runtime: 4,
            },
            extensions: {},
          },
        },
      }),
    );
    const loadFailure = new LandofileParseError({
      message: "expression ${env.DB_PASSWORD} resolved to hunter2-secret",
      filePath: join(root, ".lando.yml"),
      line: 1,
      column: 1,
    });

    // When
    const redacted: LandoEvent[] = [];
    await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published: redacted, loadFailure }))),
    );
    const bare: LandoEvent[] = [];
    await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(
        Effect.provide(runtime({ published: bare, loadFailure, redaction: false })),
      ),
    );

    // Then
    expect(notices(redacted)).toEqual([
      [
        "message.warn",
        `Skipping Landofile events for hooked: the Landofile in ${root} could not be loaded. expression \${env.DB_PASSWORD} resolved to [redacted].`,
      ],
    ]);
    expect(notices(bare)).toEqual([
      ["message.warn", `Skipping Landofile events for hooked: the Landofile in ${root} could not be loaded.`],
    ]);
  });

  test("a Landofile form conflict at the root is a load failure, not a missing Landofile", async () => {
    // Given both forms of the canonical layer
    writeFileSync(join(root, ".lando.yml"), "name: hooked\n");
    writeFileSync(join(root, ".lando.ts"), "export default { name: 'hooked' };\n");
    const target = appliedTarget(plan());
    const published: LandoEvent[] = [];

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      [
        "message.warn",
        `Skipping Landofile events for hooked: the Landofile in ${root} could not be loaded. Both ${join(root, ".lando.yml")} and ${join(root, ".lando.ts")} are present for the canonical Landofile layer.`,
      ],
    ]);
    expect(resolved.outcome).toEqual({
      status: "skipped",
      reason: `the Landofile in ${root} could not be loaded. Both ${join(root, ".lando.yml")} and ${join(root, ".lando.ts")} are present for the canonical Landofile layer`,
    });
  });

  test("a Landofile that describes another app skips with a warning", async () => {
    // Given
    writeFileSync(join(root, ".lando.yml"), "name: renamed\n");
    const target = appliedTarget(plan());
    const published: LandoEvent[] = [];
    const desired = withProjectEvents(plan({ id: AppId.make("renamed"), name: "renamed" }), desiredSteps);

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published, desired }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      [
        "message.warn",
        `Skipping Landofile events for hooked: the Landofile in ${root} describes app renamed but hooked is applied.`,
      ],
    ]);
    expect(resolved.outcome).toEqual({
      status: "skipped",
      reason: `the Landofile in ${root} describes app renamed but hooked is applied`,
    });
  });

  test("a Landofile that selects another provider skips with a warning", async () => {
    // Given
    writeFileSync(join(root, ".lando.yml"), "name: hooked\nprovider: docker\n");
    const target = appliedTarget(plan());
    const published: LandoEvent[] = [];
    const desired = withProjectEvents(plan({ provider: ProviderId.make("docker") }), desiredSteps);

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileEventPlan(target).pipe(Effect.provide(runtime({ published, desired }))),
    );

    // Then
    expect(resolved.plan.events).toEqual({});
    expect(notices(published)).toEqual([
      [
        "message.warn",
        `Skipping Landofile events for hooked: the Landofile in ${root} selects provider docker but test is applied.`,
      ],
    ]);
    expect(resolved.outcome).toEqual({
      status: "skipped",
      reason: `the Landofile in ${root} selects provider docker but test is applied`,
    });
  });
});
