import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { ConfigExpressionError, LandofileValidationError, ServiceTypeError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { FileSystem, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Layer, Result, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { resolveKnownEventSet } from "../../src/planner/event-set.ts";
import { deferredSiteKey } from "../../src/planner/landofile-scopes.ts";
import { validateResolvedLandofile } from "../../src/planner/resolved-validation.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const serviceType: ServiceType = {
  id: "validation",
  name: "validation",
  base: "l337",
  schema: Schema.Unknown,
  resolve: ({ service }) =>
    service.environment?.FAIL !== undefined
      ? Effect.fail(
          new ServiceTypeError({
            serviceType: "validation",
            message: "Reserved listener port",
            issues: [
              {
                path: service.environment.FAIL === "pgport" ? ["environment", "PGPORT"] : ["port"],
                message: "Reserved listener port",
                suggestion: "Choose another port.",
              },
            ],
            remediation: "Choose another port.",
          }),
        )
      : Effect.succeed({
          base: "l337",
          normalizedConfig: { ...service },
          nonSqlCreds: { user: "valid", password: "secret", database: "test" },
          features: [],
        }),
};
const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) =>
    PluginRegistry.of({
      ...registry,
      loadServiceType: (id) =>
        id === serviceType.id ? Effect.succeed(serviceType) : registry.loadServiceType(id),
    }),
  ),
).pipe(Layer.provide(PluginRegistryLayer.layer));

const withApp = async (yaml: string, run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-resolved-validation-"));
  try {
    await writeFile(join(root, ".lando.yml"), emitYamlDocument(Bun.YAML.parse(`name: validation\n${yaml}`)));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const planning = (root: string) =>
  Effect.gen(function* () {
    const landofile = yield* loadLandofileLayers(root, join(root, ".lando.yml"));
    const pluginRegistry = yield* PluginRegistry;
    const fileSystem = yield* FileSystem;
    return yield* resolveKnownEventSet({
      landofile,
      pluginRegistry,
      configService: undefined,
      fileSystem,
      pathsService: undefined,
      appRoot: root,
      file: join(root, ".lando.yml"),
    });
  }).pipe(Effect.provide(registryLayer), Effect.provide(BunFileSystem.layer));

const compareIssues = async (root: string, paths: readonly (readonly (string | number)[])[]) => {
  const lint = await Effect.runPromise(
    appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer), Effect.provide(BunFileSystem.layer)),
  );
  const planned = await Effect.runPromise(planning(root).pipe(Effect.result));
  if (Result.isSuccess(planned) || !(planned.failure instanceof LandofileValidationError))
    throw new Error("Expected aggregated validation failure");
  const key = (path: readonly (string | number)[]) => JSON.stringify(path);
  const expectedPaths = paths.map(key).sort();
  expect(lint.valid).toBe(false);
  expect(
    lint.violations
      .filter((issue) => issue.severity === "error")
      .map((issue) => key(issue.path))
      .sort(),
  ).toEqual(expectedPaths);
  expect(planned.failure.issues.map((issue) => key(issue.path)).sort()).toEqual(expectedPaths);
  for (const issue of planned.failure.issues)
    expect(issue.source !== undefined && "file" in issue.source ? issue.source.file : undefined).toBe(
      join(root, ".lando.yml"),
    );
  return { lint };
};

for (const [yaml, path, count] of [
  ["services: {web: {type: validation, networks: [ghost]}}", ["services", "web", "networks", "ghost"], 1],
  ["networks: {default: {}}", ["networks", "default"], 1],
  ["networks: {peer: {external: true, driver: bridge}}", ["networks", "peer", "driver"], 1],
  ["networks: {peer: {name: chosen}}", ["networks", "peer", "name"], 1],
  ["networks: {'bad/key': {}}", ["networks", "bad/key"], 1],
  ["networks: {peer: {external: true, name: lando_bridge_network}}", ["networks", "peer"], 1],
  ["networks: {peer: {external: true, name: lando-validation}}", ["networks", "peer"], 1],
  ["networks: {peer: {external: true, name: lando-validation_former-owned}}", ["networks", "peer"], 1],
  [
    "networks: {lando-validation_former-owned: {external: true}}",
    ["networks", "lando-validation_former-owned"],
    1,
  ],
  [
    "networks: {first: {external: true, name: sibling_net}, second: {external: true, name: sibling_net}}\nservices: {web: {type: validation, networks: [first, second]}}",
    ["networks", "second"],
    1,
  ],
  [
    "networks: {extra: {}, peer: {external: true, name: lando-validation_extra}}\nservices: {web: {type: validation, networks: [extra, peer]}}",
    ["networks", "peer"],
    2,
  ],
] as const)
  test(`lint and planning reject invalid network at ${path.join(".")} (${yaml})`, async () => {
    await withApp(yaml, async (root) => {
      const { lint } = await compareIssues(
        root,
        Array.from({ length: count }, () => path),
      );
      expect(lint.violations[0]).toMatchObject({
        rule: "landofile.network",
        path,
        message: expect.any(String),
        suggestion: expect.any(String),
      });
    });
  });

test("lint permits service default membership and declared external networks", async () => {
  await withApp(
    "networks: {peer: {external: true}}\nservices: {web: {type: validation, networks: [default, peer]}}",
    async (root) => {
      const lint = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer), Effect.provide(BunFileSystem.layer)),
      );
      expect(lint.valid).toBe(true);
    },
  );
});

test("top-level env file failures aggregate with independent service and route issues", async () => {
  await withApp(
    "env_file: [missing.env]\nservices:\n  db:\n    type: validation\n    environment: {FAIL: yes}\n  web:\n    type: validation\n    routes: [bad_host!]\n",
    async (root) => {
      const { lint } = await compareIssues(root, [
        ["env_file", 0],
        ["services", "db", "port"],
        ["services", "web", "routes", 0],
      ]);
      expect(lint.violations[0]?.message).toContain(join(root, "missing.env"));
    },
  );
});

test("lint and planning aggregate service, hostname and materialized route fields", async () => {
  await withApp(
    `services:
  mq:
    type: validation
    port: 15672
    environment: {FAIL: yes}
  db:
    type: validation
    environment: {FAIL: pgport, PGPORT: abc}
  web:
    type: validation
    hostnames: [bad_host!]
    routes:
      - hostname: "{{ app.name }}_bad.lndo.site"
      - hostname: ok.lndo.site
        pathPrefix: no-slash
`,
    async (root) => {
      const { lint } = await compareIssues(root, [
        ["services", "mq", "port"],
        ["services", "db", "environment", "PGPORT"],
        ["services", "web", "hostnames", 0],
        ["services", "web", "routes", 0, "hostname"],
        ["services", "web", "routes", 1, "pathPrefix"],
      ]);
      expect(lint.violations.map((issue) => issue.rule)).toEqual([
        "landofile.service",
        "landofile.service",
        "landofile.route",
        "landofile.route",
        "landofile.hostname",
      ]);
      for (const issue of lint.violations)
        expect(issue).toMatchObject({ line: expect.any(Number), scopes: ["effective"] });
    },
  );
});

test("failed credential sources skip transitive consumers but not independent failures", async () => {
  await withApp(
    `services:
  db:
    type: validation
    environment: {FAIL: yes}
  consumer:
    type: validation
    environment: {U: "{{ services.db.creds.user }}"}
  transitive:
    type: validation
    environment: {U: "{{ services.consumer.creds.user }}"}
  independent:
    type: validation
    environment: {FAIL: yes}
`,
    async (root) => {
      await compareIssues(root, [
        ["services", "db", "port"],
        ["services", "independent", "port"],
      ]);
    },
  );
});

test("post-resolve log failures still publish credentials to consumers", async () => {
  await withApp(
    `services:
  db:
    type: validation
    logs: [{id: x, path: /tmp/a}, {id: x, path: /tmp/b}]
  api:
    type: validation
    environment: {U: "{{ services.db.creds.user }}", FAIL: yes}
`,
    async (root) => {
      await compareIssues(root, [
        ["services", "db", "logs", 1, "id"],
        ["services", "api", "port"],
      ]);
    },
  );
});

test("blocked route fields are skipped while sibling fields and static routes still validate", async () => {
  await withApp(
    `services:
  db:
    type: validation
    environment: {FAIL: yes}
  web:
    type: validation
    routes:
      - hostname: "{{ services.db.creds.user }}_bad.lndo.site"
        pathPrefix: no-slash
      - hostname: static_bad.lndo.site
`,
    async (root) => {
      await compareIssues(root, [
        ["services", "db", "port"],
        ["services", "web", "routes", 0, "pathPrefix"],
        ["services", "web", "routes", 1, "hostname"],
      ]);
    },
  );
});

test("blocked routes preserve later binding indexes while independent failures accumulate", async () => {
  // Given
  await withApp(
    `services:
  db:
    type: validation
    environment: {FAIL: yes}
  web:
    type: validation
    routes:
      - hostname: static.lndo.site
proxy:
  web:
    - hostname: "{{ services.db.creds.user }}.lndo.site"
    - proxy.lndo.site
`,
    async (root) => {
      // When / Then
      await compareIssues(root, [
        ["services", "db", "port"],
        ["services", "web", "routes", 0],
        ["proxy", "web", 1],
      ]);
    },
  );
});

test("undeclared proxy targets retain indexed findings beside invalid and unavailable services", async () => {
  // Given
  await withApp(
    `services:
  web:
    type: validation
    routes: []
  unavailable:
    type: validation
    environment: {FAIL: yes}
proxy:
  typo:
    - bad_host!
    - first.lndo.site
    - second.lndo.site
  unavailable:
    - unavailable.lndo.site
`,
    async (root) => {
      // When / Then
      await compareIssues(root, [
        ["services", "unavailable", "port"],
        ["proxy", "typo", 0],
        ["proxy", "typo", 1],
        ["proxy", "typo", 2],
      ]);
    },
  );
});

test("unknown services in top-level tooling remain expression failures", async () => {
  await withApp(
    `services:
  web: {type: validation}
tooling:
  t: {service: web, cmd: "echo {{ services.nope.creds.user }}"}
`,
    async (root) => {
      const planned = await Effect.runPromise(planning(root).pipe(Effect.result));
      expect(Result.isFailure(planned) && planned.failure instanceof ConfigExpressionError).toBe(true);
      const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
      expect(lint.violations).toMatchObject([
        { rule: "landofile.expression", path: ["tooling", "t", "cmd"] },
      ]);
    },
  );
});

test("local override routes retain layer attribution in lint and planning", async () => {
  await withApp("services:\n  web: {type: validation, routes: [valid.lndo.site]}\n", async (root) => {
    await writeFile(
      join(root, ".lando.local.yml"),
      emitYamlDocument(Bun.YAML.parse("services:\n  web:\n    routes: [{hostname: bad_host!}]\n")),
    );
    const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    const planned = await Effect.runPromise(planning(root).pipe(Effect.result));
    if (Result.isSuccess(planned) || !(planned.failure instanceof LandofileValidationError))
      throw new Error("Expected route failure");
    for (const issue of [...lint.violations, ...planned.failure.issues])
      expect(issue.source).toMatchObject({ file: join(root, ".lando.local.yml"), layer: "local" });
  });
});

test("all unsupported authored healthcheck kinds are reported together", async () => {
  await withApp(
    "services:\n  a: {type: validation, healthcheck: {kind: http, url: 'http://localhost'}}\n  b: {type: validation, healthcheck: {kind: tcp, port: 80}}\n",
    async (root) => {
      await compareIssues(root, [
        ["services", "a", "healthcheck", "kind"],
        ["services", "b", "healthcheck", "kind"],
      ]);
    },
  );
});

test.each([{ target: "host" }, { target: "host", command: "true", user: "root" }])(
  "lint reports unsupported host healthcheck execution",
  async (healthcheck) => {
    // Given
    await withApp(
      emitYamlDocument({ services: { web: { type: "validation", healthcheck } } }),
      async (root) => {
        // When
        const lint = await Effect.runPromise(
          appConfigLint({ cwd: root }).pipe(
            Effect.provide(registryLayer),
            Effect.provide(BunFileSystem.layer),
          ),
        );
        // Then
        expect(lint.valid).toBe(false);
        expect(lint.violations).toContainEqual(
          expect.objectContaining({
            rule: "healthcheck.execution-target",
            path: ["services", "web", "healthcheck"],
            severity: "error",
          }),
        );
      },
    );
  },
);

test("declared timestamped log sources lint and resolve successfully", async () => {
  await withApp(
    "services:\n  web: {type: validation, logs: [{id: app, path: /tmp/app.log, timestamps: true}]}\n",
    async (root) => {
      const lint = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
      const resolved = await Effect.runPromise(planning(root));
      expect(lint.valid).toBe(true);
      expect(resolved.services[0]?.logSources).toContainEqual(
        expect.objectContaining({ id: "app", timestamps: true }),
      );
    },
  );
});

test("a blocked descendant site suppresses checks on its ancestor path", () => {
  // Given two external networks whose names collide only while one name is still unresolved
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { networks: { a: {}, b: {} } } },
    networks: { a: { external: true, name: "shared" }, b: { external: true, name: "shared" } },
  });
  const validate = (blocked: ReadonlySet<string>) =>
    validateResolvedLandofile({
      landofile,
      landofilePath: "/app/.lando.yml",
      blocked,
      appSlug: "app",
    }).issues.filter((issue) => issue.rule === "landofile.network");
  // When the second network's name is a blocked deferred site / Then its ancestor check is skipped
  expect(validate(new Set())).toHaveLength(1);
  expect(validate(new Set([deferredSiteKey(["networks", "b", "name"])]))).toEqual([]);
  // And a sibling key that only shares a prefix is not treated as a descendant
  expect(validate(new Set([deferredSiteKey(["networks", "bb", "name"])]))).toHaveLength(1);
});
