import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Either } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { type WindowsSyncTargetOperations, prepareWindowsSyncTargets } from "../src/windows-sync-targets.ts";

const image = `example.invalid/lando-sync@sha256:${"a".repeat(64)}`;
const root = AbsolutePath.make("C:\\Users\\me\\demo");
const appId = AppId.make("demo-id");
const provider = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "windows-sync-targets.test.ts",
  runtime: 4 as const,
};

const service = (name: "web" | "worker"): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider,
  primary: name === "web",
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  appMount: {
    source: root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    excludes: [],
    includes: [],
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const plan = (): AppPlan => {
  const web = service("web");
  const worker = service("worker");
  return {
    id: appId,
    name: "demo",
    slug: "demo",
    root,
    provider,
    services: { [web.name]: web, [worker.name]: worker },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [web, worker].map((entry) => ({
      engineId: "mutagen",
      session: {
        app: { kind: "user" as const, id: appId, root },
        service: entry.name,
        mountKey: "app-mount",
        source: root,
        target: {
          _tag: "volume" as const,
          name: `demo-${entry.name}-app-mount`,
          path: PortablePath.make("/app"),
        },
        mode: "two-way-safe" as const,
        excludes: [],
      },
    })),
    metadata,
    extensions: {},
  };
};

const failure = (message: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "test",
    message,
    remediation: "repair test fixture",
  });

const helpers = (
  events: string[],
  options: {
    readonly resources?: Map<string, string>;
    readonly failImage?: boolean;
    readonly wrongEndpoint?: string;
    readonly failEnsureOnce?: string;
  } = {},
): WindowsSyncTargetOperations => {
  const resources = options.resources ?? new Map<string, string>();
  let failEnsure = options.failEnsureOnce;
  return {
    prepareImage: () =>
      Effect.gen(function* () {
        events.push("image");
        if (options.failImage) return yield* Effect.fail(failure("image pull failed"));
      }),
    ensure: (spec) =>
      Effect.gen(function* () {
        events.push(`ensure:${spec.service}`);
        const id = resources.get(spec.service) ?? `container-${spec.service}`;
        resources.set(spec.service, id);
        if (spec.service === failEnsure) {
          failEnsure = undefined;
          return yield* Effect.fail(failure("ensure failed after durable create"));
        }
        return {
          containerId: id,
          containerName: `helper-${spec.service}`,
          volumeName:
            spec.service === options.wrongEndpoint ? "foreign-volume" : `demo-${spec.service}-app-mount`,
          path: "/sync" as const,
        };
      }),
  };
};

describe("Windows sync target set preparation", () => {
  test("rejects incomplete coverage and mutable helper images before any provider action", async () => {
    const events: string[] = [];
    const complete = plan();
    const invalid = { ...complete, fileSync: complete.fileSync.slice(0, 1) };
    const incomplete = await Effect.runPromise(
      Effect.either(prepareWindowsSyncTargets(invalid, image, helpers(events))),
    );
    const mutable = await Effect.runPromise(
      Effect.either(prepareWindowsSyncTargets(plan(), "alpine:latest", helpers(events))),
    );
    expect(Either.isLeft(incomplete)).toBe(true);
    expect(Either.isLeft(mutable)).toBe(true);
    expect(events).toEqual([]);
  });

  test("image preparation failure creates no helper", async () => {
    const events: string[] = [];
    const resources = new Map<string, string>();
    const result = await Effect.runPromise(
      Effect.either(
        prepareWindowsSyncTargets(plan(), image, helpers(events, { resources, failImage: true })),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(events).toEqual(["image"]);
    expect(resources.size).toBe(0);
  });

  test("returns exact endpoints without exposing an unsafe rollback operation", async () => {
    const events: string[] = [];
    const resources = new Map<string, string>();
    const operations = helpers(events, { resources });
    const prepared = await Effect.runPromise(prepareWindowsSyncTargets(plan(), image, operations));
    const reused = await Effect.runPromise(prepareWindowsSyncTargets(plan(), image, operations));
    expect(prepared.targets.map(({ session, endpoint }) => [session.service, endpoint.containerId])).toEqual([
      ["web", "container-web"],
      ["worker", "container-worker"],
    ]);
    expect(reused.targets.map(({ endpoint }) => endpoint.containerId)).toEqual([
      "container-web",
      "container-worker",
    ]);
    expect(Object.hasOwn(prepared, "rollback")).toBe(false);
    expect([...resources.keys()]).toEqual(["web", "worker"]);
  });

  test("rejects a mismatched endpoint while preserving the helper for ownership recovery", async () => {
    const events: string[] = [];
    const resources = new Map<string, string>();
    const result = await Effect.runPromise(
      Effect.either(
        prepareWindowsSyncTargets(plan(), image, helpers(events, { resources, wrongEndpoint: "web" })),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(events).toEqual(["image", "ensure:web"]);
    expect(resources.get("web")).toBe("container-web");
  });

  test("preserves a helper persisted before ensure fails and reuses both helpers on retry", async () => {
    const events: string[] = [];
    const resources = new Map<string, string>();
    const operations = helpers(events, { resources, failEnsureOnce: "worker" });
    const failed = await Effect.runPromise(
      Effect.either(prepareWindowsSyncTargets(plan(), image, operations)),
    );
    expect(Either.isLeft(failed)).toBe(true);
    expect([...resources.keys()]).toEqual(["web", "worker"]);
    expect(events).toEqual(["image", "ensure:web", "ensure:worker"]);

    const recovered = await Effect.runPromise(prepareWindowsSyncTargets(plan(), image, operations));
    expect(recovered.targets.map(({ endpoint }) => endpoint.containerId)).toEqual([
      "container-web",
      "container-worker",
    ]);
    expect([...resources.keys()]).toEqual(["web", "worker"]);
  });
});
