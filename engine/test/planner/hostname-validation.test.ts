import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { FileSystem, PluginRegistry } from "@lando/sdk/services";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Result, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { resolveKnownEventSet } from "../../src/planner/event-set.ts";
import { deferredSiteKey } from "../../src/planner/landofile-scopes.ts";
import { validateResolvedLandofile } from "../../src/planner/resolved-validation.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

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

test("host alias validation skips blocked and pending expression sites", () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: { web: { extra_hosts: { "bad host": "{{ services.db.creds.user }}" } } },
  });
  const path = ["services", "web", "extra_hosts", "bad host"];
  const result = validateResolvedLandofile({
    landofile,
    landofilePath: "/app/.lando.yml",
    blocked: new Set([deferredSiteKey(path)]),
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
    blocked: new Set([deferredSiteKey(["services", "web", "routes", 1, "endpoint"])]),
  });
  expect(result.issues.map((issue) => [issue.rule, issue.path.join(".")]).toSorted()).toEqual([
    ["landofile.route", "services.web.routes.0.hostname"],
    ["landofile.route", "services.web.routes.0.pathPrefix"],
    ["landofile.route", "services.web.routes.1.hostname"],
  ]);
});
