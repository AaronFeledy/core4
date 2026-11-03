import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const unsupported = [
  { type: "nginx" },
  { type: "nginx", backend: "   " },
  { type: "nginx", backend: "appserver", command: ["nginx", "-g", "daemon off;"] },
  { type: "nginx", backend: "appserver", entrypoint: ["/custom-nginx"] },
  { type: "apache" },
  { type: "php:8.3", via: "fpm" },
  { type: "php:8.3", via: "cli" },
  { type: "php:8.3", image: "custom/php:8.3" },
  { type: "php:8.3", command: ["custom"] },
  { type: "php:8.3", entrypoint: ["custom"] },
  { type: "php:8.3", build: { context: "." } },
  { type: "static" },
] satisfies readonly (typeof ServiceConfig.Encoded)[];

const plan = (service: typeof ServiceConfig.Encoded) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "upload-dirs-contract",
    services: {
      appserver: { type: "php:8.3", home: false, certs: false },
      web: { home: false, certs: false, ...service },
    },
  });
  return Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(literalTestLandofile(landofile, process.cwd()), {
      ...TestRuntimeProvider.capabilities,
      artifactBuild: true,
    }),
  ).pipe(Effect.provide(Planner.layer), Effect.provide(Plugins.layer));
};

test.each(unsupported)("rejects non-empty uploadDirs without a supporting feature: %j", async (service) => {
  // Given / When
  const result = await Effect.runPromise(Effect.result(plan({ ...service, uploadDirs: ["uploads"] })));
  // Then
  if (!Result.isFailure(result)) throw new Error("Expected unsupported uploadDirs rejection");
  expect(result.failure).toBeInstanceOf(LandofileValidationError);
  if (!(result.failure instanceof LandofileValidationError)) throw result.failure;
  expect(result.failure.issues).toEqual([
    expect.objectContaining({ path: ["services", "web", "uploadDirs"], suggestion: expect.any(String) }),
  ]);
});

test.each(unsupported)("accepts an empty uploadDirs override: %j", async (service) => {
  // Given / When
  const result = await Effect.runPromise(plan({ ...service, uploadDirs: [] }));
  // Then
  expect(result.services[ServiceName.make("web")]).toBeDefined();
});

test("nginx with a backend denies the script FastCGI executes", async () => {
  // Given / When
  const result = await Effect.runPromise(
    plan({ type: "nginx", backend: "appserver", uploadDirs: ["uploads*"] }),
  );
  // Then
  const plannedCommand = result.services[ServiceName.make("web")]?.command;
  const command = typeof plannedCommand === "string" ? plannedCommand : (plannedCommand?.join(" ") ?? "");
  const deny = 'if ($fastcgi_script_name ~* "^/(?:uploads[^/]*)/") { return 403; }';
  expect(command).toContain(deny);
  expect(command.indexOf(deny)).toBeGreaterThan(command.indexOf("fastcgi_split_path_info"));
  expect(command.indexOf(deny)).toBeLessThan(command.indexOf("if (!-f"));
});

test.each([{}, { via: "apache" }])("PHP Apache accepts uploadDirs with %j", async (config) => {
  // Given / When
  const result = await Effect.runPromise(plan({ type: "php:8.3", ...config, uploadDirs: ["uploads"] }));
  // Then
  expect(result.services[ServiceName.make("web")]?.command).toContain("php_admin_flag engine off");
});

test("lint identifies unsupported uploadDirs at the authored service field", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-upload-dirs-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: upload-dirs-lint\nservices:\n  web:\n    type: nginx\n    uploadDirs: [uploads]\n",
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Plugins.layer)));
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: ["services", "web", "uploadDirs"],
        severity: "error",
        message: "Service web lists uploadDirs, but Lando can't keep PHP out of them on this service.",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
