import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { FileSystem, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Result, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { resolveKnownEventSet } from "../../src/planner/event-set.ts";
import { validateResolvedLandofile } from "../../src/planner/resolved-validation.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { planApp } from "../plan-app.ts";

const withApp = async (service: unknown, run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-hostname-validation-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument({ name: "hostnames", services: { web: service } }),
    );
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
  }).pipe(Effect.provide(PluginRegistryLayer.layer), Effect.provide(BunFileSystem.layer));

const lintAndPlan = async (root: string) => {
  const lint = await Effect.runPromise(
    appConfigLint({ cwd: root }).pipe(
      Effect.provide(PluginRegistryLayer.layer),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const planned = await Effect.runPromise(planning(root).pipe(Effect.result));
  return [lint, planned] as const;
};

test("plans concrete addresses from deferred list-form extra_hosts values", () =>
  withApp(
    {
      type: "compose",
      image: "alpine:3.22",
      extra_hosts: [
        "peer=192.0.2.1",
        "{{ env.HOST }}:{{ app.name == 'hostnames' ? env.ADDRESS : '::1' }}",
        "{{ env.HOST }}={{ app.name == 'hostnames' ? '192.0.2.3' : '::1' }}",
      ],
    },
    async (root) => {
      const planned = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: {
            resolveUserCacheRoot: () => join(root, "cache"),
            resolveUserIncludesDir: () => join(root, "includes"),
            sources: {},
          },
          templates: {
            modules: [],
            context: {
              env: { HOST: "peer", ADDRESS: "2001:db8::2" },
              scope: "app",
              bootstrapLevel: "plugins",
            },
          },
        }).pipe(
          Effect.flatMap((landofile) =>
            planApp(
              { landofile, providerCapabilities: TestRuntimeProvider.capabilities },
              PluginRegistryLayer.layer,
            ),
          ),
        ),
      );
      expect(planned.services[ServiceName.make("web")]?.extensions).toMatchObject({
        compose: { extra_hosts: { peer: ["192.0.2.1", "2001:db8::2", "192.0.2.3"] } },
      });
    },
  ));

test.each([
  { extra_hosts: { "bad host": "1.2.3.4" } },
  { extra_hosts: ["bad host:1.2.3.4"] },
  { extra_hosts: ["bad host=1.2.3.4"] },
])("lint and planning reject an invalid extra_hosts name (%j)", async ({ extra_hosts }) => {
  await withApp({ type: "nginx", extra_hosts }, async (root) => {
    const [lint, planned] = await lintAndPlan(root);
    const issue = { rule: "landofile.hostname", path: ["services", "web", "extra_hosts", "bad host"] };
    expect(lint.valid).toBe(false);
    expect(lint.violations).toMatchObject([{ ...issue, severity: "error" }]);
    if (Result.isSuccess(planned) || !(planned.failure instanceof LandofileValidationError))
      throw new Error("Expected a LandofileValidationError for the host alias");
    expect(planned.failure.issues).toMatchObject([issue]);
  });
});

test.each([
  { extra_hosts: { my_db: "1.2.3.4", gateway: "host-gateway" } },
  { extra_hosts: ["my_db:1.2.3.4", "gateway=host-gateway"] },
])(
  "lint and planning accept host aliases with underscores and gateway values (%j)",
  async ({ extra_hosts }) => {
    await withApp({ type: "nginx", extra_hosts }, async (root) => {
      const [lint, planned] = await lintAndPlan(root);
      expect(lint.violations).toEqual([]);
      expect(Result.isSuccess(planned)).toBe(true);
    });
  },
);

test.each([
  { route: "wild.*.app.lndo.site", tail: [] },
  { route: { hostname: "wild.*.app.lndo.site" }, tail: ["hostname"] },
  { route: { hostname: "wild.*.app.lndo.site", scheme: "both" }, tail: ["hostname"] },
])("lint and planning reject HTTPS routes with deeper wildcards (%j)", async ({ route, tail }) => {
  await withApp({ type: "nginx", routes: [route] }, async (root) => {
    const [lint, planned] = await lintAndPlan(root);
    const issue = { rule: "landofile.route", path: ["services", "web", "routes", 0, ...tail] };
    expect(lint.violations).toMatchObject([{ ...issue, severity: "error" }]);
    if (Result.isSuccess(planned) || !(planned.failure instanceof LandofileValidationError))
      throw new Error("Expected a LandofileValidationError for HTTPS certificate coverage");
    expect(planned.failure.issues).toMatchObject([issue]);
  });
});

test.each(["*-app.lndo.site", { hostname: "wild.*.app.lndo.site", scheme: "http" }])(
  "lint and planning accept certificate-coverable HTTPS or deeper HTTP wildcards (%j)",
  async (route) => {
    await withApp({ type: "nginx", routes: [route] }, async (root) => {
      const [lint, planned] = await lintAndPlan(root);
      expect(lint.violations).toEqual([]);
      expect(Result.isSuccess(planned)).toBe(true);
    });
  },
);

test("a certificate-rejected route cannot supply the listener for a portless sibling", async () => {
  await withApp(
    {
      type: "compose",
      image: "nginx:alpine",
      routes: [{ hostname: "wild.*.app.lndo.site", scheme: "both", endpoint: 8080 }, "web.lndo.site"],
    },
    async (root) => {
      const lint = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
      );
      expect(lint.violations.map(({ rule, path }) => ({ rule, path }))).toEqual([
        { rule: "landofile.route", path: ["services", "web", "routes", 0, "hostname"] },
        { rule: "landofile.route", path: ["services", "web", "routes", 1] },
      ]);
    },
  );
});

test("host alias validation skips blocked and pending expression sites", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { extra_hosts: { "bad host": "{{ services.db.creds.user }}" } } },
  });
  const path = ["services", "web", "extra_hosts", "bad host"];
  const result = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [path],
  });
  expect(result.issues).toEqual([]);
});

test("HTTPS coverage is reported alongside other route field failures and unresolved fields", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: {
      web: {
        routes: [
          { hostname: "wild.*.app.lndo.site", pathPrefix: "not-a-path" },
          { hostname: "deep.*.app.lndo.site", endpoint: "{{ services.web.port }}" },
        ],
      },
    },
  });
  const result = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: [["services", "web", "routes", 1, "endpoint"]],
  });
  expect(result.issues.map((issue) => [issue.rule, issue.path.join(".")]).toSorted()).toEqual([
    ["landofile.route", "services.web.routes.0.hostname"],
    ["landofile.route", "services.web.routes.0.pathPrefix"],
    ["landofile.route", "services.web.routes.1.hostname"],
  ]);
});
