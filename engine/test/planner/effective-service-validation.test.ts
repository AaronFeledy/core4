import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

test("lint aggregates service-relative image and bind findings without derivative claims noise", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-effective-validation-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: effective-validation\nservices:\n  store:\n    type: minio\n    consolePort: 19001\n    endpoints: []\n  mail:\n    type: mailpit\n    endpoints: []\n    environment:\n      MP_UI_BIND_ADDR: 127.0.0.1:8025\n",
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(Registry.layer)));
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map((issue) => issue.path)).toEqual([
      ["services", "store", "image"],
      ["services", "mail", "environment", "MP_UI_BIND_ADDR"],
    ]);
    expect(
      result.violations.every((issue) => typeof issue.suggestion === "string" && issue.suggestion.length > 0),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { image: "example.test/minio:fixture" },
  { build: { context: ".", dockerfile_inline: "FROM example.test/minio:fixture" } },
])("planner accepts explicit MinIO artifact intent without pulling %j", async (artifact) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-minio-artifact-"));
  try {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "minio-artifact",
      services: { store: { type: "minio", home: false, certs: false, ...artifact } },
    });
    // When
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(landofile, root), {
          ...TestRuntimeProvider.capabilities,
          artifactBuild: true,
        }),
      ).pipe(Effect.provide(Planner.layer), Effect.provide(Registry.layer)),
    );
    // Then
    expect(plan.services[ServiceName.make("store")]?.artifact).toMatchObject(
      "image" in artifact ? { kind: "ref", ref: artifact.image } : { kind: "build" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
