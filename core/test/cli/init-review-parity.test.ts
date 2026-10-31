import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSites } from "@lando/landofile/compiled-sites";
import { parseLandofile } from "@lando/landofile/parser";
import { PLAN_IDENTITY_EXPRESSION_SCOPES, recipeOptionScope } from "@lando/landofile/recipe-expressions";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { normalizeRoute } from "@lando/landofile/route-normalize";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { projectInitReviewRoutes } from "../../src/cli/commands/init-review-routes";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access";

test("post-answer URL candidates agree with the independently reloaded committed recipe branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-summary-parity-"));
  try {
    const recipe = join(root, "branch-recipe");
    await mkdir(recipe);
    await Bun.write(
      join(recipe, "recipe.yml"),
      `id: branch-recipe
title: Branch recipe
description: Summary parity fixture
version: 1.0.0
options:
  insecure:
    type:
      kind: boolean
    default: false
  scheme:
    type:
      kind: string
    default: https
  path:
    type:
      kind: string
    default: /default
config:
  runtime: 4
  router:
    httpPort: 8000
  services:
    web:
      type: node:22
      endpoints:
        - _tag: internal
          protocol: http
          port: 3000
      routes:
        - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"
          scheme: "{{ recipe.scheme }}"
          pathPrefix: "{{ recipe.path }}"
variants:
  - when: "{{ options.insecure }}"
    config:
      router:
        httpPort: 8088
`,
    );
    let displayed: readonly string[] = [];
    const result = await initApp({
      cwd: root,
      destination: join(root, "project"),
      userDataRoot: join(root, "state"),
      recipe,
      full: false,
      runPostInit: false,
      interaction: {
        promptAll: async () => ({ name: "summary-app", insecure: true, scheme: "http", path: "/final" }),
        confirm: async () => {
          throw new TypeError("Unexpected clean-path approval");
        },
        select: async () => {
          throw new TypeError("Unexpected recipe selection");
        },
      },
      onPrepared: async (review) => {
        displayed = projectInitReviewRoutes(review, {
          proxy: { defaultDomain: "custom.test" },
        }).candidates.map(({ url }) => url);
      },
    });

    const file = join(result.directory, ".lando.yml");
    const loaded = await Effect.runPromise(
      parseLandofile({ file, cwd: result.directory, content: await Bun.file(file).text() }).pipe(
        Effect.flatMap((value) =>
          loadAuthoredDocuments([{ file, value }], { file, appRoot: result.directory }),
        ),
      ),
    );
    const resolved = Result.getOrThrow(
      consumeSites({
        document: loaded.document,
        pendingSites: loaded.pendingSites,
        scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
        context: {
          app: { name: "summary-app", slug: "summary-app" },
          proxy: { defaultDomain: "custom.test" },
          recipe: recipeOptionScope(loaded.document),
          env: {},
        },
      }),
    );
    const document = Schema.decodeUnknownSync(Schema.toType(LandofileShape))(resolved.document);
    const route = document.services?.[ServiceName.make("web")]?.routes?.[0];
    if (route === undefined) throw new TypeError("Committed route missing");
    const normalized = Result.getOrThrow(normalizeRoute(route, { path: ["services", "web", "routes", 0] }));
    expect(normalized).toMatchObject({
      hostname: "summary-app.custom.test",
      scheme: "http",
      pathPrefix: "/final",
    });
    expect(document.router).toMatchObject({ httpPort: 8088 });
    expect(displayed).toEqual(["http://summary-app.custom.test:8088/final"]);
    expect(result.preview.outputs.map(({ destination }) => destination)).toEqual([".lando.yml"]);
    expect(result.receipt.created.map(({ path }) => path)).toEqual([".lando.yml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
