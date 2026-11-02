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
  { type: "php:8.3" },
] satisfies readonly (typeof ServiceConfig.Encoded)[];

const plan = (service: typeof ServiceConfig.Encoded) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "no-scripts-contract",
    services: {
      appserver: { type: "php:8.3", home: false, certs: false },
      web: { home: false, certs: false, ...service },
    },
  });
  return Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(literalTestLandofile(landofile, process.cwd()), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(Planner.layer), Effect.provide(Plugins.layer));
};

test.each(unsupported)("rejects non-empty noScripts without a supporting feature: %j", async (service) => {
  // Given / When
  const result = await Effect.runPromise(Effect.result(plan({ ...service, noScripts: ["uploads"] })));
  // Then
  if (!Result.isFailure(result)) throw new Error("Expected unsupported noScripts rejection");
  expect(result.failure).toBeInstanceOf(LandofileValidationError);
  if (!(result.failure instanceof LandofileValidationError)) throw result.failure;
  expect(result.failure.issues).toEqual([
    expect.objectContaining({ path: ["services", "web", "noScripts"], suggestion: expect.any(String) }),
  ]);
});

test.each(unsupported)("accepts an empty noScripts override: %j", async (service) => {
  // Given / When
  const result = await Effect.runPromise(plan({ ...service, noScripts: [] }));
  // Then
  expect(result.services[ServiceName.make("web")]).toBeDefined();
});

test("nginx with a backend generates PHP denial before FastCGI", async () => {
  // Given / When
  const result = await Effect.runPromise(
    plan({ type: "nginx", backend: "appserver", noScripts: ["uploads*"] }),
  );
  // Then
  const plannedCommand = result.services[ServiceName.make("web")]?.command;
  const command = typeof plannedCommand === "string" ? plannedCommand : (plannedCommand?.join(" ") ?? "");
  const deny = "location ~* ^/uploads[^/]*/[\\s\\S]*\\.php(/|$) { deny all; }";
  expect(command).toContain(deny);
  expect(command.indexOf(deny)).toBeLessThan(command.indexOf("location ~ [^/]\\.php(/|$)"));
});

test("lint identifies unsupported noScripts at the authored service field", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-no-scripts-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: no-scripts-lint\nservices:\n  web:\n    type: nginx\n    noScripts: [uploads]\n",
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Plugins.layer)));
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ path: ["services", "web", "noScripts"], severity: "error" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
