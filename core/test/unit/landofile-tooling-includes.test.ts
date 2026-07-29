import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";

import { getLocalIncludePaths } from "../../src/landofile/include-provenance.ts";
import { resolveLandofileIncludes } from "../../src/landofile/includes.ts";
import { getInternalToolingTasks } from "../../src/landofile/tooling-include-provenance.ts";

const resolve = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(resolveLandofileIncludes({ landofile, appRoot, cacheRoot: join(appRoot, ".cache") }));

const failure = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(
    Effect.flip(resolveLandofileIncludes({ landofile, appRoot, cacheRoot: join(appRoot, ".cache") })),
  );

const DOCS_FRAGMENT = [
  "tooling:",
  "  build:",
  "    service: node",
  "    cmd: bun run build",
  "  serve:",
  "    service: node",
  "    cmd: bun run serve",
  "    vars:",
  "      DOCS_PORT: 5173",
  "  publish:",
  "    service: node",
  "    cmd: bun run publish",
  "",
].join("\n");

describe("tooling includes — canonical includes[] kind: tooling", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-includes-"));
    await mkdir(join(appRoot, "docs"), { recursive: true });
    await writeFile(join(appRoot, "docs", ".lando.tasks.yml"), DOCS_FRAGMENT, "utf8");
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("namespaces included tasks, aliases the namespace, applies excludes, and layers include vars", async () => {
    // Given a tooling include declaring a namespace, alias, exclude, and include-level vars
    const landofile: LandofileShape = {
      name: "demo",
      includes: [
        {
          source: "./docs/.lando.tasks.yml",
          kind: "tooling",
          namespace: "docs",
          aliases: ["documentation"],
          excludes: ["publish"],
          vars: { DOCS_PORT: 4321 },
        },
      ],
    };

    // When the Landofile is resolved
    const resolved = await resolve(landofile, appRoot);

    // Then included tasks register under the namespace and its alias, excludes are gone,
    // and include vars apply only where the task did not define its own value.
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual([
      "docs:build",
      "docs:serve",
      "documentation:build",
      "documentation:serve",
    ]);
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("bun run build");
    expect(resolved.tooling?.["docs:build"]?.vars?.DOCS_PORT).toBe(4321);
    expect(resolved.tooling?.["docs:serve"]?.vars?.DOCS_PORT).toBe(5173);
    expect(resolved.tooling?.["documentation:build"]?.cmd).toBe("bun run build");
  });

  test("flatten registers included tasks without the namespace prefix", async () => {
    // Given
    const landofile: LandofileShape = {
      includes: [{ source: "./docs/.lando.tasks.yml", kind: "tooling", namespace: "docs", flatten: true }],
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual(["build", "publish", "serve"]);
  });

  test("internal marks every included task hidden without polluting the task shape", async () => {
    // Given
    const landofile: LandofileShape = {
      includes: [{ source: "./docs/.lando.tasks.yml", kind: "tooling", namespace: "docs", internal: true }],
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect([...getInternalToolingTasks(resolved)].sort()).toEqual([
      "docs:build",
      "docs:publish",
      "docs:serve",
    ]);
    expect(resolved.tooling?.["docs:build"]).not.toHaveProperty("internal");
  });

  test("the Landofile's own tooling task wins over an included task of the same id", async () => {
    // Given
    const landofile: LandofileShape = {
      includes: [{ source: "./docs/.lando.tasks.yml", kind: "tooling", namespace: "docs", flatten: true }],
      tooling: { build: { service: "web", cmd: "make authored" } },
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect(resolved.tooling?.build?.cmd).toBe("make authored");
    expect(resolved.tooling?.build?.service).toBe("web");
  });

  test("records the fragment path as a local include path so command caches invalidate", async () => {
    // Given
    const landofile: LandofileShape = {
      includes: [{ source: "./docs/.lando.tasks.yml", kind: "tooling", namespace: "docs" }],
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect(getLocalIncludePaths(resolved).some((path) => path.endsWith(".lando.tasks.yml"))).toBe(true);
  });

  test("consumes the tooling include entry instead of leaving it in the resolved Landofile", async () => {
    // Given
    const landofile: LandofileShape = {
      includes: [{ source: "./docs/.lando.tasks.yml", kind: "tooling", namespace: "docs", flatten: true }],
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect(resolved.includes).toBeUndefined();
    expect(resolved).not.toHaveProperty("toolingIncludes");
  });

  test("resolves a tooling source relative to its declaring Landofile fragment", async () => {
    // Given an ordinary Landofile fragment that declares a relative tooling include
    await mkdir(join(appRoot, "fragments"), { recursive: true });
    await writeFile(
      join(appRoot, "fragments", "app.yml"),
      ["toolingIncludes:", "  docs:", "    file: ./tasks.yml", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      join(appRoot, "fragments", "tasks.yml"),
      ["tooling:", "  build:", "    cmd: bun run build", ""].join("\n"),
      "utf8",
    );

    // When the complete include tree is resolved
    const resolved = await resolve({ includes: ["./fragments/app.yml"] }, appRoot);

    // Then the tooling source uses the directory of the fragment that declared it
    expect(resolved.tooling?.["docs:build"]?.cmd).toBe("bun run build");
  });
});

describe("tooling includes — toolingIncludes shorthand", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-includes-shorthand-"));
    await mkdir(join(appRoot, "docs"), { recursive: true });
    await writeFile(join(appRoot, "docs", ".lando.tasks.yml"), DOCS_FRAGMENT, "utf8");
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("produces the same resolved tooling as the equivalent includes[] entry", async () => {
    // Given the canonical and shorthand spellings of the same include
    const canonical: LandofileShape = {
      name: "demo",
      includes: [
        {
          source: "./docs/.lando.tasks.yml",
          kind: "tooling",
          namespace: "docs",
          aliases: ["documentation"],
          excludes: ["publish"],
          vars: { DOCS_PORT: 4321 },
        },
      ],
    };
    const shorthand: LandofileShape = {
      name: "demo",
      toolingIncludes: {
        docs: {
          file: "./docs/.lando.tasks.yml",
          aliases: ["documentation"],
          excludes: ["publish"],
          vars: { DOCS_PORT: 4321 },
        },
      },
    };

    // When both are resolved
    const [fromCanonical, fromShorthand] = await Promise.all([
      resolve(canonical, appRoot),
      resolve(shorthand, appRoot),
    ]);

    // Then they produce identical plans
    expect(fromShorthand.tooling).toEqual(fromCanonical.tooling);
  });

  test("carries internal through the shorthand form too", async () => {
    // Given
    const landofile: LandofileShape = {
      toolingIncludes: { docs: { file: "./docs/.lando.tasks.yml", internal: true, excludes: ["publish"] } },
    };

    // When
    const resolved = await resolve(landofile, appRoot);

    // Then
    expect([...getInternalToolingTasks(resolved)].sort()).toEqual(["docs:build", "docs:serve"]);
  });

  test("resolves nested tooling includes relative to the declaring fragment", async () => {
    // Given a fragment that itself declares a tooling include one directory deeper
    await mkdir(join(appRoot, "docs", "api"), { recursive: true });
    await writeFile(
      join(appRoot, "docs", ".lando.tasks.yml"),
      [
        "toolingIncludes:",
        "  api:",
        "    file: ./api/.lando.tasks.yml",
        "tooling:",
        "  build:",
        "    cmd: bun run build",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(appRoot, "docs", "api", ".lando.tasks.yml"),
      ["tooling:", "  lint:", "    cmd: bun run lint", ""].join("\n"),
      "utf8",
    );

    // When
    const resolved = await resolve(
      { toolingIncludes: { docs: { file: "./docs/.lando.tasks.yml" } } },
      appRoot,
    );

    // Then the nested include is namespaced beneath its parent namespace
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual(["docs:api:lint", "docs:build"]);
  });
});

describe("tooling includes — failure modes", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-includes-fail-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("a missing fragment fails closed with a tagged include error", async () => {
    // When
    const error = await failure(
      { toolingIncludes: { docs: { file: "./missing/.lando.tasks.yml" } } },
      appRoot,
    );

    // Then
    expect(error._tag).toBe("LandofileIncludeError");
    expect(error.message).toContain("./missing/.lando.tasks.yml");
  });

  test("optional suppresses a missing fragment", async () => {
    // When
    const resolved = await resolve(
      { toolingIncludes: { docs: { file: "./missing/.lando.tasks.yml", optional: true } } },
      appRoot,
    );

    // Then
    expect(resolved.tooling).toBeUndefined();
  });

  test("optional does not suppress an outside-root fragment", async () => {
    // Given a missing optional fragment whose authored path escapes the app root
    const outside = join(appRoot, "..", "missing-tooling-fragment.yml");

    // When
    const result = await Effect.runPromise(
      Effect.either(
        resolveLandofileIncludes({
          landofile: { toolingIncludes: { out: { file: outside, optional: true } } },
          appRoot,
          cacheRoot: join(appRoot, ".cache"),
        }),
      ),
    );

    // Then containment still fails closed before optional missing-file handling
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("LandofileIncludeError");
      if (result.left._tag === "LandofileIncludeError") expect(result.left.kind).toBe("outside-root");
    }
  });

  test("a cyclic tooling include fails with ToolingIncludeCycleError", async () => {
    // Given two fragments that include each other
    await writeFile(
      join(appRoot, "a.tasks.yml"),
      ["toolingIncludes:", "  b:", "    file: ./b.tasks.yml", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      join(appRoot, "b.tasks.yml"),
      ["toolingIncludes:", "  a:", "    file: ./a.tasks.yml", ""].join("\n"),
      "utf8",
    );

    // When
    const error = await failure({ toolingIncludes: { a: { file: "./a.tasks.yml" } } }, appRoot);

    // Then
    expect(error._tag).toBe("ToolingIncludeCycleError");
    if (error._tag === "ToolingIncludeCycleError") {
      expect(error.remediation.length).toBeGreaterThan(0);
    }
  });

  test("a fragment outside the app root is rejected", async () => {
    // Given
    const outside = await mkdtemp(join(tmpdir(), "lando-tooling-outside-"));
    await writeFile(join(outside, "tasks.yml"), "tooling:\n  x:\n    cmd: echo\n", "utf8");

    // When
    const error = await failure({ toolingIncludes: { out: { file: join(outside, "tasks.yml") } } }, appRoot);

    // Then
    expect(error._tag).toBe("LandofileIncludeError");
    await rm(outside, { recursive: true, force: true });
  });

  test("a tooling fragment may not carry non-tooling Landofile keys", async () => {
    // Given
    await writeFile(
      join(appRoot, "tasks.yml"),
      ["services:", "  web:", "    type: node", "tooling:", "  build:", "    cmd: make", ""].join("\n"),
      "utf8",
    );

    // When
    const error = await failure({ toolingIncludes: { t: { file: "./tasks.yml" } } }, appRoot);

    // Then
    expect(error._tag).toBe("LandofileIncludeError");
    expect(error.message).toContain("services");
  });

  test("two includes claiming the same task id fail closed instead of silently overwriting", async () => {
    // Given two fragments whose namespaces collide through an alias
    await writeFile(join(appRoot, "one.yml"), "tooling:\n  build:\n    cmd: one\n", "utf8");
    await writeFile(join(appRoot, "two.yml"), "tooling:\n  build:\n    cmd: two\n", "utf8");

    // When
    const error = await failure(
      {
        toolingIncludes: {
          docs: { file: "./one.yml" },
          api: { file: "./two.yml", aliases: ["docs"] },
        },
      },
      appRoot,
    );

    // Then
    expect(error._tag).toBe("LandofileIncludeError");
    expect(error.message).toContain("docs:build");
  });

  test("a tooling fragment carrying a Beta-only task field is rejected with remediation", async () => {
    // Given
    await writeFile(
      join(appRoot, "tasks.yml"),
      ["tooling:", "  build:", "    cmd: make", "    deps:", "      - assets", ""].join("\n"),
      "utf8",
    );

    // When
    const error = await failure({ toolingIncludes: { t: { file: "./tasks.yml" } } }, appRoot);

    // Then
    expect(error._tag).toBe("NotImplementedError");
  });

  test("tooling-only include fields are rejected on a landofile-kind include", async () => {
    // Given
    await writeFile(join(appRoot, "frag.yml"), "services:\n  web:\n    type: node\n", "utf8");

    // When
    const error = await failure(
      { includes: [{ source: "./frag.yml", kind: "landofile", namespace: "docs" }] },
      appRoot,
    );

    // Then
    expect(error._tag).toBe("LandofileIncludeError");
    expect(error.message).toContain("namespace");
  });
});
