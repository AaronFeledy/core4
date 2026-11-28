import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAppEvent } from "@lando/engine/operations/events";
import { withProjectEvents } from "@lando/engine/planner/effective-events";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { makeShellRunnerService } from "@lando/engine/services/shell-runner";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  EventService,
  type EventServiceShape,
  ProcessRunner,
  Renderer,
  RouterService,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";
import { TestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, DateTime, Effect, Layer, Queue, Stream } from "effect";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { environmentResolverLayer } from "../_support/value-contracts.ts";

const providerId = ProviderId.make("test");
const webName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "event-script-route-facts.test",
  runtime: 4 as const,
};
const web: ServicePlan = {
  name: webName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const route: RoutePlan = {
  hostname: "applied.test",
  scheme: "https",
  service: webName,
  priority: 1,
  backend: { service: webName, port: 3000, protocol: "http" },
};

const plan = (root: string): AppPlan => ({
  id: AppId.make("event-script-route-facts"),
  name: "event-script-route-facts",
  slug: "event-script-route-facts",
  root: AbsolutePath.make(root),
  provider: providerId,
  services: { [webName]: web },
  routes: [route],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const eventService: EventServiceShape = {
  publish: () => Effect.void,
  subscribe: () => Stream.empty,
  subscribeQueue: Effect.gen(function* () {
    const queue = yield* Queue.unbounded<never>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    return queue;
  }),
  waitFor: () => Effect.never,
  subscribeWithHistory: () => Effect.never,
  waitForAny: () => Effect.never,
  query: () => Effect.succeed([]),
};

const harness = (root: string) => {
  const redaction = makeRedactionService();
  const runner = Effect.runSync(ProcessRunner.pipe(Effect.provide(BunProcessRunner.layer)));
  const environment = Effect.runSync(
    Effect.scoped(
      Effect.flatMap(Layer.build(environmentResolverLayer({}, redaction)), (built) =>
        Effect.succeed(Context.get(built, EnvironmentValueResolver)),
      ),
    ),
  );
  const router = TestRouterService;
  return {
    redaction,
    context: Context.make(Context.Service<unknown>("event-script-route-facts"), {}).pipe(
      Context.add(EventService, eventService),
      Context.add(
        Renderer,
        Renderer.of({
          id: "silent",
          capabilities: RENDERER_CAPABILITIES_NONE,
          message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
          output: { stdout: () => Effect.void, stderr: () => Effect.void },
        }),
      ),
      Context.add(RedactionService, redaction),
      Context.add(EnvironmentValueResolver, environment),
      Context.add(PrivateFileAccessService, ownerOnlyFileAccess),
      Context.add(ProcessRunner, runner),
      Context.add(
        ShellRunner,
        makeShellRunnerService(
          () => {
            throw new TypeError("Interactive shell IO was not expected in this test.");
          },
          ownerOnlyFileAccess,
          runner,
        ),
      ),
      Context.add(
        RouterService,
        RouterService.of({
          ...router,
          routeAuthorities: () =>
            Effect.succeed([{ hostname: route.hostname, scheme: "https" as const, port: 8443 }]),
        }),
      ),
      Context.add(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          list: Effect.succeed([providerId]),
          readAppliedPlanStrict: () => Effect.succeed(plan(root)),
        }),
      ),
    ),
  };
};

const script = (marker: string) =>
  [
    "# ---",
    "# env:",
    '#   SITE: "{{ services.web.url }}"',
    "# ---",
    `printf "%s" "$SITE" > ${marker}`,
    "",
  ].join("\n");

const withApp = async (run: (root: string, marker: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-event-script-route-"));
  const marker = join(root, "url");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: event-script-route-facts\n");
    await writeFile(join(root, ".lando/scripts/smoke.bun.sh"), script(marker));
    await run(root, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runCanonical = async (root: string, event: "pre-start" | "post-start") => {
  const { context, redaction } = harness(root);
  const target = withProjectEvents(plan(root), {
    [event]: [{ command: "app:smoke", ignoreError: true }],
  });
  return Effect.runPromise(
    runAppEvent(target, event).pipe(
      Effect.provideService(EventCommandExecutor, makeEventCommandExecutor(context)),
      Effect.provide(context),
      Effect.provideService(RedactionService, redaction),
      Effect.result,
    ),
  );
};

test("a canonical command: script step cannot be excused from an event-phase refusal", async () => {
  await withApp(async (root) => {
    // When
    const result = await runCanonical(root, "pre-start");
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileEventStepFailedError",
        kind: "command",
        outputTail: "",
        issues: [{ reason: "event-phase", path: ["env", "SITE"] }],
      },
    });
  });
});

test("a canonical command: script step resolves the applied route in a post-start step", async () => {
  await withApp(async (root, marker) => {
    // When
    const result = await runCanonical(root, "post-start");
    // Then
    expect(result._tag).toBe("Success");
    expect(await Bun.file(marker).text()).toBe("https://applied.test:8443");
  });
});
