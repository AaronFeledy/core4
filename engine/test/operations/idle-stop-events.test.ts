import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, PortablePath, appIdentityKey } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { compileEffectiveEvents, withEventsPlan } from "../../src/planner/effective-events.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as HostToolingEngine from "../../src/services/host-tooling-engine.ts";
import * as ProcessRunner from "../../src/services/process-runner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("idle stop keeps its event bracket and runs host steps while noticing skipped container steps", async () => {
  const root = AbsolutePath.make(await realpath(await mkdtemp(join(tmpdir(), "lando-idle-stop-events-"))));
  try {
    const planned = withEventsPlan(
      {
        ...plan,
        root,
        identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
      },
      compileEffectiveEvents({
        landofile: {
          events: {
            "pre-start": ["unused-container-hook"],
            "pre-stop": [
              { service: ":host", dir: PortablePath.make(root), cmd: "echo pre > pre.txt" },
              "container-pre",
            ],
            "post-stop": [
              { service: ":host", dir: PortablePath.make(root), cmd: "echo post > post.txt" },
              "container-post",
            ],
          },
        },
        hostEvents: {
          "pre-stop": [
            { service: ":host", cmd: `echo host > "${root}/host.txt"` },
            { service: "web", cmd: "host-container" },
          ],
        },
        services: plan.services,
      }),
    );
    const runtimeActions: string[] = [];
    const harness = makeHarness({
      plannedApp: planned,
      appliedPlans: [planned],
      providerOverrides: {
        getStatus: Effect.succeed({ state: "idle" }),
        ensureReady: Effect.sync(() => {
          runtimeActions.push("ready");
        }),
      },
      onDestroy: () => runtimeActions.push("destroy"),
      exec: () => Effect.die("idle stop must not execute in containers"),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        return yield* stopAppForTarget(
          {},
          {
            plan: planned,
            root,
            app: { kind: "user", id: planned.id, root },
            landofile: literalTestLandofile({ name: planned.name, services: {} }, root),
          },
        ).pipe(
          Effect.provideService(EventService, {
            ...events,
            publish: (event) =>
              event._tag === "pre-shell-exec" || event._tag === "post-shell-exec"
                ? Effect.void
                : events.publish(event),
          }),
        );
      }).pipe(
        Effect.provide(
          HostToolingEngine.layer.pipe(Layer.provideMerge(Layer.merge(harness.layer, ProcessRunner.layer))),
        ),
        Effect.provide(BunFileSystem.layer),
      ),
    );

    expect(result.outcome).toBe("stopped");
    expect(await Bun.file(join(root, "pre.txt")).text()).toBe("pre\n");
    expect(await Bun.file(join(root, "post.txt")).text()).toBe("post\n");
    expect(await Bun.file(join(root, "host.txt")).text()).toBe("host\n");
    expect(
      harness.events
        .map((event) => event._tag)
        .filter((tag) =>
          [
            "pre-app-stop",
            "pre-stop",
            "pre-service-stop",
            "post-service-stop",
            "post-app-stop",
            "post-stop",
          ].includes(tag),
        ),
    ).toEqual([
      "pre-app-stop",
      "pre-stop",
      "pre-service-stop",
      "post-service-stop",
      "post-app-stop",
      "post-stop",
    ]);
    const notices = harness.events.flatMap((event) =>
      event._tag === "message.info" && event.body.includes("idle") ? [event.body] : [],
    );
    expect(notices).toHaveLength(3);
    expect(runtimeActions).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
