import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  ProviderId,
  appIdentityKey,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  type LandoEvent,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Stream } from "effect";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { attachEffectiveEvents, compileEffectiveEvents } from "../../src/planner/effective-events.ts";
import { EventCommandExecutor } from "../../src/services/event-command-executor.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { emptySnapshotsLayer } from "./data-mover-support.ts";

export const withTeardownRoot = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-teardown-events-")));
  try {
    await Bun.write(join(root, ".lando.yml"), "name: teardown-events\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const recordedPlan = (root: string): AppPlan => ({
  id: AppId.make("teardown-events"),
  name: "teardown-events",
  slug: "teardown-events",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: appIdentityKey("owner", root) },
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: ".lando.yml", runtime: 4 },
  extensions: {},
});

export const targetFor = (plan: AppPlan): ResolvedAppTarget => ({
  plan,
  root: plan.root,
  app: { kind: "user", id: plan.id, root: plan.root },
});

export const authoredPlan = (root: string) =>
  attachEffectiveEvents(
    recordedPlan(root),
    compileEffectiveEvents({
      landofile: {
        events: {
          "pre-init": [{ command: "info", flags: { marker: "pre-init" } }],
          "post-init": [{ command: "info", flags: { marker: "post-init" } }],
          "pre-stop": [{ command: "info", flags: { marker: "pre-stop" } }],
          "post-stop": [{ command: "info", flags: { marker: "post-stop" } }],
          "pre-destroy": [{ command: "app:info" }],
          "post-destroy": [{ command: "info", flags: { marker: "post-destroy" } }],
        },
      },
      hostEvents: {
        "pre-destroy": [{ command: "app:config" }, { command: "app:info" }],
      },
    }),
  );

export const invalidLandofile = new LandofileValidationError({
  message: "Invalid authored configuration",
  remediation: "Repair the Landofile.",
  file: ".lando.yml",
  issues: [{ path: [], message: "invalid fixture" }],
});

export const authoredTeardownHarness = (input: {
  readonly applied: AppPlan;
  readonly desired?: AppPlan;
  readonly plannerFailure?: LandofileValidationError;
}) => {
  const order: string[] = [];
  const events: LandoEvent[] = [];
  const destroyed: AppPlan[] = [];
  const stepPlans: Array<AppPlan | undefined> = [];
  const toolInvocations: ToolingInvocation[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    destroy: (target: { readonly plan?: AppPlan }) =>
      Effect.sync(() => {
        order.push("provider");
        if (target.plan !== undefined) destroyed.push(target.plan);
        return { kind: "destroyed" as const };
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "test",
        run: (invocation, plan) =>
          Effect.sync(() => {
            order.push(`tool:${invocation.tool}`);
            toolInvocations.push(invocation);
            stepPlans.push(plan);
            return { tool: invocation.tool, service: ":lando", exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
    emptySnapshotsLayer,
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: join(input.applied.root, "data"),
        userCacheRoot: join(input.applied.root, "cache"),
        userConfRoot: join(input.applied.root, "conf"),
        systemPluginRoot: join(input.applied.root, "sys"),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.suspend(() => {
          order.push("load");
          return input.desired === undefined
            ? Effect.fail(invalidLandofile)
            : Effect.succeed({ name: input.desired.name, services: {} } satisfies LandofileShape);
        }),
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: () =>
          Effect.suspend(() => {
            order.push("plan");
            return input.plannerFailure !== undefined
              ? Effect.fail(input.plannerFailure)
              : input.desired === undefined
                ? Effect.fail(invalidLandofile)
                : Effect.succeed(input.desired);
          }),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([input.applied.provider]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed(input.applied),
        resolveTeardownEvidence: () =>
          Effect.sync(() => {
            order.push("evidence");
            return { kind: "applied" as const, plan: input.applied };
          }),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
            order.push(event._tag);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.die("unused"),
        waitFor: () => Effect.die("unused"),
        waitForAny: () => Effect.die("unused"),
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        payloadValues: () => Effect.succeed(() => []),
        forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
      }),
    ),
    Layer.succeed(
      EventCommandExecutor,
      EventCommandExecutor.of({
        run: (input) =>
          Effect.sync(() => {
            order.push(`step:${input.flags.marker ?? input.command}`);
            stepPlans.push(input.plan);
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  return { layer, order, events, destroyed, stepPlans, toolInvocations };
};
