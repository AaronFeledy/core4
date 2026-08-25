import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { AbsolutePath, AppPlan, type ServicePlan } from "@lando/sdk/schema";
import type { LandoEvent as PublishedEvent } from "@lando/sdk/services";

import { makeBuildTaskProgress } from "../../src/services/build-task-progress.ts";

const collectPublisher = () => {
  const events: LandoEvent[] = [];
  return {
    events,
    publish: (event: PublishedEvent) =>
      Schema.is(LandoEventSchema)(event)
        ? Effect.sync(() => {
            events.push(event);
          })
        : Effect.die(new TypeError(`Unexpected event in build-task-progress test: ${event._tag}`)),
  };
};

const byTag = <T extends LandoEvent["_tag"]>(events: ReadonlyArray<LandoEvent>, tag: T) =>
  events.filter((event): event is Extract<LandoEvent, { readonly _tag: T }> => event._tag === tag);

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "artifact-app",
  name: "Artifact App",
  slug: "artifact-app",
  root: "/tmp/artifact-app",
  provider: "test",
  services: {
    web: {
      name: "web",
      type: "node",
      provider: "test",
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: { resolvedAt: "2026-07-17T00:00:00.000Z", source: "build-task-progress.test", runtime: 4 },
      extensions: {},
    },
    db: {
      name: "db",
      type: "postgres",
      provider: "test",
      primary: false,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: { resolvedAt: "2026-07-17T00:00:00.000Z", source: "build-task-progress.test", runtime: 4 },
      extensions: {},
    },
    cache: {
      name: "cache",
      type: "redis",
      provider: "test",
      primary: false,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: { resolvedAt: "2026-07-17T00:00:00.000Z", source: "build-task-progress.test", runtime: 4 },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: "2026-07-17T00:00:00.000Z", source: "build-task-progress.test", runtime: 4 },
  extensions: {},
});

const requireService = (name: string): ServicePlan => {
  const service = Object.values(plan.services).find((candidate) => String(candidate.name) === name);
  if (service === undefined) throw new TypeError(`${name} service fixture is missing`);
  return service;
};

const web = requireService("web");
const db = requireService("db");
const cache = requireService("cache");
const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
const parentId = `build-artifact-${String(plan.id)}`;

describe("makeBuildTaskProgress", () => {
  test("startTree publishes parent identity, label, service-name children, and list mode", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);

    // When
    await Effect.runPromise(progress.startTree);

    // Then
    expect(progress.parentId).toBe(parentId);
    expect(byTag(publisher.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      label: `Building ${plan.name}`,
      children: [String(web.name), String(db.name), String(cache.name)],
      mode: "list",
    });
  });

  test("startTask publishes Build label and transcript path", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);

    // When
    await Effect.runPromise(progress.startTask(web, transcriptPath));

    // Then
    expect(byTag(publisher.events, "task.start")[0]).toMatchObject({
      taskId: String(web.name),
      parentId,
      label: `Build ${String(web.name)}`,
      transcriptPath,
    });
  });

  test("completeTask and completeTree publish caller summary and success counts", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);
    await Effect.runPromise(progress.startTask(web, transcriptPath));
    await Effect.runPromise(progress.startTask(db, transcriptPath));
    await Effect.runPromise(progress.startTask(cache, transcriptPath));

    // When
    await Effect.runPromise(progress.completeTask(web, `${String(web.name)} cached`));
    await Effect.runPromise(progress.completeTask(db, `Built ${String(db.name)}`));
    await Effect.runPromise(progress.completeTask(cache, `Built ${String(cache.name)}`));
    await Effect.runPromise(progress.completeTree);

    // Then
    expect(byTag(publisher.events, "task.complete").map((event) => event.summary)).toEqual([
      `${String(web.name)} cached`,
      `Built ${String(db.name)}`,
      `Built ${String(cache.name)}`,
    ]);
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      summary: `${plan.name} built`,
      succeeded: 3,
      failed: 0,
    });
  });

  test("failTask and failTree publish fail summary, exit code, and fail counts", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);
    await Effect.runPromise(progress.startTask(web, transcriptPath));
    await Effect.runPromise(progress.startTask(db, transcriptPath));

    // When
    await Effect.runPromise(progress.completeTask(web, `Built ${String(web.name)}`));
    await Effect.runPromise(progress.failTask(db));
    await Effect.runPromise(progress.abortTask(cache, transcriptPath));
    await Effect.runPromise(progress.failTree);

    // Then
    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId: String(db.name),
      summary: `Build ${String(db.name)} failed`,
      exitCode: 1,
    });
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      summary: `${plan.name} build failed`,
      succeeded: 1,
      failed: 2,
    });
  });

  test("abortTask on an unstarted service emits start then fail", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);

    // When
    await Effect.runPromise(progress.abortTask(web, transcriptPath));

    // Then
    expect(byTag(publisher.events, "task.start")).toHaveLength(1);
    expect(byTag(publisher.events, "task.start")[0]).toMatchObject({
      taskId: String(web.name),
      parentId,
      label: `Build ${String(web.name)}`,
      transcriptPath,
    });
    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId: String(web.name),
      summary: `Build ${String(web.name)} aborted`,
      exitCode: 1,
    });
  });

  test("abortTask on a started service does not emit a duplicate start", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);
    await Effect.runPromise(progress.startTask(web, transcriptPath));

    // When
    await Effect.runPromise(progress.abortTask(web, transcriptPath));

    // Then
    expect(byTag(publisher.events, "task.start")).toHaveLength(1);
    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId: String(web.name),
      summary: `Build ${String(web.name)} aborted`,
      exitCode: 1,
    });
  });

  test("unsettledServices excludes complete, fail, and abort and keeps started", async () => {
    // Given
    const publisher = collectPublisher();
    const progress = makeBuildTaskProgress(publisher, plan);
    await Effect.runPromise(progress.startTree);
    await Effect.runPromise(progress.startTask(web, transcriptPath));

    // When
    await Effect.runPromise(progress.completeTask(db, `Built ${String(db.name)}`));
    await Effect.runPromise(progress.failTask(cache));

    // Then
    expect(progress.unsettledServices().map((service) => String(service.name))).toEqual([String(web.name)]);

    await Effect.runPromise(progress.abortTask(web, transcriptPath));
    expect(progress.unsettledServices()).toEqual([]);
  });
});
