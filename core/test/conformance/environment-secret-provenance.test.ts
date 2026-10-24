import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineHttpApi, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { bringUp } from "@lando/container-runtime/podman/bring-up";
import { effectiveToolingForPlan } from "@lando/engine/planner/effective-tooling";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as ProviderExecToolingEngine from "@lando/engine/services/tooling-engine";
import { RedactionService } from "@lando/redaction/service";
import "../../src/runtime/engine-composition.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { loadLandofileFile } from "@lando/landofile/service";
import { AbsolutePath, type AppPlan, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  type CommandSpec,
  EnvironmentValueResolver,
  SecretStore,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Stream } from "effect";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";

const planFile = async (file: string, env: Readonly<Record<string, string>> = {}) => {
  const appRoot = dirname(file);
  const loaded = await Effect.runPromise(
    loadLandofileFile(file, {
      appRoot,
      layer: "canonical",
      policy: DEFAULT_LANDOFILE_LOAD_POLICY,
      pendingSites: [],
      compilationContext: { appRoot: AbsolutePath.make(appRoot), env },
    }),
  );
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(loaded, TestRuntimeProvider.capabilities)).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(PluginRegistryLayer.layerWith({ app: false, user: false }, BUNDLED_PLUGIN_MODULES)),
    ),
  );
};

const resolverLayer = (calls: string[], value: string) => {
  const storeLayer = Layer.succeed(
    SecretStore,
    SecretStore.of({
      id: "test",
      get: (key) => {
        calls.push(key);
        return Effect.succeed(value);
      },
      has: () => Effect.succeed(true),
      list: Effect.succeed([]),
    }),
  );
  const redactionLayer = RedactionService.layer.pipe(Layer.provide(storeLayer));
  return EnvironmentValueResolverLayer.layer.pipe(Layer.provide(Layer.mergeAll(storeLayer, redactionLayer)));
};

const resolveWith = (app: AppPlan, calls: string[], value: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* EnvironmentValueResolver).openSession();
        const entries = yield* Effect.forEach(Object.values(app.services), (service) =>
          session
            .resolveEnvironment(service.environment)
            .pipe(Effect.map((env) => [service.name, env] as const)),
        );
        return Object.fromEntries(entries);
      }),
    ).pipe(Effect.provide(resolverLayer(calls, value))),
  );

test.each([
  ["{{ env.PAYLOAD }}", "${secret:TEST}"],
  ["{{ load('./payload.txt') }}", "${secret:TEST}"],
  ["$${secret:TEST}", "${secret:TEST}"],
  ["{{ env.PAYLOAD }}", "$${HOME} {{{{literal"],
  ["${secret:TEST}", "$${HOME} {{{{literal ${secret:OTHER}"],
] as const)("keeps builtin Postgres credential projection literal: %s -> %s", async (password, payload) => {
  const root = await mkdtemp(join(tmpdir(), "lando-postgres-provenance-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(join(root, "payload.txt"), payload);
    await writeFile(
      file,
      [
        "name: provenance",
        "services:",
        "  db:",
        "    type: postgres",
        "    home: false",
        "    appMount: false",
        ...(password === "${secret:TEST}"
          ? ["    environment:", `      POSTGRES_PASSWORD: ${JSON.stringify(password)}`]
          : [
              "    creds:",
              "      user: lando",
              "      database: app",
              `      password: ${JSON.stringify(password)}`,
            ]),
      ].join("\n"),
    );
    const app = await planFile(file, { PAYLOAD: payload });
    const calls: string[] = [];
    const overrides = await resolveWith(app, calls, payload);
    const durable = JSON.stringify(app);
    const requests: EngineHttpRequest[] = [];
    let created = false;
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          if (request.method === "GET" && request.path.endsWith("/json"))
            return created
              ? { status: 200, body: JSON.stringify({ Id: "db", State: { Running: true } }) }
              : { status: 404, body: "{}" };
          if (request.method === "GET") return { status: 404, body: "{}" };
          if (request.path.startsWith("/containers/create?")) created = true;
          return { status: request.path.endsWith("/start") ? 204 : 201, body: "{}" };
        }),
    };
    await Effect.runPromise(
      bringUp(app, {
        api,
        ctx: { providerId: "lando", remediation: "Repair test engine." },
        resolveServiceEnvironment: (service) => Effect.succeed(overrides[service.name] ?? {}),
      }),
    );
    const expected = password === "$${secret:TEST}" ? "${secret:TEST}" : payload;
    const bound = password === "${secret:TEST}";
    expect(calls).toEqual(bound ? ["TEST"] : []);
    expect(app.services[ServiceName.make("db")]?.connection?.creds.password).toEqual(
      bound ? { _tag: "SecretRef", reference: "TEST" } : expected,
    );
    expect(requests.find((request) => request.path.startsWith("/containers/create?"))?.body).toMatchObject({
      Env: expect.arrayContaining([`POSTGRES_PASSWORD=${expected}`, `LANDO_DB_PASSWORD=${expected}`]),
    });
    if (bound)
      expect(app.services[ServiceName.make("db")]?.environment.POSTGRES_PASSWORD).toEqual({
        _tag: "SecretRef",
        reference: "TEST",
      });
    const task = effectiveToolingForPlan(app)?.psql;
    expect(task?.env?.PGPASSWORD).toEqual(app.services[ServiceName.make("db")]?.connection?.creds.password);
    const commands: CommandSpec[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* ToolingEngine;
        return yield* engine.run(
          { tool: "psql", service: "db", commands: [["psql"]], env: task?.env ?? {} },
          app,
          {
            ...TestRuntimeProvider,
            execStream: (_target, command) => {
              commands.push(command);
              return Stream.make({ exitCode: 0 });
            },
          },
        );
      }).pipe(
        Effect.provide(ProviderExecToolingEngine.layer.pipe(Layer.provide(resolverLayer(calls, payload)))),
      ),
    );
    expect(commands[0]?.env?.PGPASSWORD).toBe(expected);
    expect(JSON.stringify(app)).toBe(durable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps cross-service credential projections as data", async () => {
  // Given a literal secret-shaped password projected into another builtin service.
  const root = await mkdtemp(join(tmpdir(), "lando-cross-creds-provenance-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      [
        "name: provenance",
        "services:",
        "  db:",
        "    type: postgres",
        "    home: false",
        "    appMount: false",
        "    creds:",
        "      user: lando",
        "      database: app",
        '      password: "$${secret:TEST}"',
        "  reader:",
        "    type: postgres",
        "    home: false",
        "    appMount: false",
        "    environment:",
        '      CROSS: "{{ services.db.creds.password }}"',
      ].join("\n"),
    );
    const calls: string[] = [];
    // When
    const app = await planFile(file);
    const overrides = await resolveWith(app, calls, "store");
    // Then
    expect(app.services[ServiceName.make("reader")]?.environment.CROSS).toBe("${secret:TEST}");
    expect(overrides[ServiceName.make("reader")]?.CROSS).toBe("${secret:TEST}");
    expect(calls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
