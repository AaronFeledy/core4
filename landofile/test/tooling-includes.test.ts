import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";

import { getLocalIncludePaths } from "../src/include-provenance.ts";
import { resolveLandofileIncludes } from "../src/includes.ts";
import { getInternalToolingTasks } from "../src/tooling-include-provenance.ts";
import { makeTestLandofilePorts } from "./support.ts";

const resolve = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(
    resolveLandofileIncludes({
      landofile,
      appRoot,
      cacheRoot: join(appRoot, ".cache"),
      ports: makeTestLandofilePorts(join(appRoot, ".cache")),
    }),
  );

const failure = (landofile: LandofileShape, appRoot: string) =>
  Effect.runPromise(
    Effect.flip(
      resolveLandofileIncludes({
        landofile,
        appRoot,
        cacheRoot: join(appRoot, ".cache"),
        ports: makeTestLandofilePorts(join(appRoot, ".cache")),
      }),
    ),
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

  test("flatten combined with aliases fails closed instead of dropping the aliases", async () => {
    // Given a flattened include that also declares namespace aliases
    const landofile: LandofileShape = {
      includes: [
        {
          source: "./docs/.lando.tasks.yml",
          kind: "tooling",
          namespace: "docs",
          flatten: true,
          aliases: ["documentation"],
        },
      ],
    };

    // When the include is resolved
    const error = await failure(landofile, appRoot);

    // Then the unusable combination is rejected with remediation rather than silently ignored
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") {
      expect(error.kind).toBe("forbidden-field");
      expect(error.remediation).toContain("flatten");
    }
  });

  test("the shorthand rejects flatten with aliases the same way the canonical spelling does", async () => {
    // Given the equivalent shorthand spelling of the same unusable combination
    const landofile: LandofileShape = {
      toolingIncludes: {
        docs: { file: "./docs/.lando.tasks.yml", flatten: true, aliases: ["documentation"] },
      },
    };

    // When the include is resolved
    const error = await failure(landofile, appRoot);

    // Then both spellings fail identically
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
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

  test("keeps canonical tooling declarations from every ordinary fragment", async () => {
    // Given two ordinary fragments that each declare a distinct canonical tooling include
    await mkdir(join(appRoot, "a"), { recursive: true });
    await mkdir(join(appRoot, "b"), { recursive: true });
    await writeFile(join(appRoot, "a", "tasks.yml"), "tooling:\n  build:\n    cmd: a\n", "utf8");
    await writeFile(join(appRoot, "b", "tasks.yml"), "tooling:\n  test:\n    cmd: b\n", "utf8");
    await writeFile(
      join(appRoot, "a", "app.yml"),
      ["includes:", "  - source: ./tasks.yml", "    kind: tooling", "    namespace: a", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      join(appRoot, "b", "app.yml"),
      ["includes:", "  - source: ./tasks.yml", "    kind: tooling", "    namespace: b", ""].join("\n"),
      "utf8",
    );

    // When both fragments are included and the equivalent shorthand is resolved
    const canonical = await resolve({ includes: ["./a/app.yml", "./b/app.yml"] }, appRoot);
    const shorthand = await resolve(
      { toolingIncludes: { a: { file: "./a/tasks.yml" }, b: { file: "./b/tasks.yml" } } },
      appRoot,
    );

    // Then neither fragment's declaration is dropped and both spellings agree
    expect(Object.keys(canonical.tooling ?? {}).sort()).toEqual(["a:build", "b:test"]);
    expect(canonical.tooling).toEqual(shorthand.tooling);
  });

  test("keeps every canonical declaration pointing one namespace at several fragments", async () => {
    // Given two canonical tooling includes in one array sharing a namespace
    await writeFile(join(appRoot, "a.yml"), "tooling:\n  atask:\n    cmd: a\n", "utf8");
    await writeFile(join(appRoot, "b.yml"), "tooling:\n  btask:\n    cmd: b\n", "utf8");

    // When the Landofile is resolved
    const resolved = await resolve(
      {
        includes: [
          { source: "./a.yml", kind: "tooling", namespace: "shared" },
          { source: "./b.yml", kind: "tooling", namespace: "shared" },
        ],
      },
      appRoot,
    );

    // Then neither sibling declaration is treated as an override of the other
    expect(Object.keys(resolved.tooling ?? {}).sort()).toEqual(["shared:atask", "shared:btask"]);
  });

  test("still rejects sibling declarations that contribute the same task id", async () => {
    // Given two canonical tooling includes whose tasks collide under one namespace
    await writeFile(join(appRoot, "a.yml"), "tooling:\n  build:\n    cmd: a\n", "utf8");
    await writeFile(join(appRoot, "b.yml"), "tooling:\n  build:\n    cmd: b\n", "utf8");

    // When the Landofile is resolved
    const failure = await resolve(
      {
        includes: [
          { source: "./a.yml", kind: "tooling", namespace: "shared" },
          { source: "./b.yml", kind: "tooling", namespace: "shared" },
        ],
      },
      appRoot,
    ).catch((cause: unknown) => cause);

    // Then the collision fails closed instead of silently picking a winner
    expect(String(failure)).toContain('Tooling includes both contribute task "shared:build"');
  });

  test("rejects a remote source in either include spelling", async () => {
    // Given the same remote intent authored through each spelling
    const canonical = await resolve(
      { includes: [{ source: "https://example.test/tasks.yml", kind: "tooling", namespace: "ns" }] },
      appRoot,
    ).catch((cause: unknown) => cause);
    const shorthand = await resolve(
      { toolingIncludes: { ns: { file: "https://example.test/tasks.yml", optional: true } } },
      appRoot,
    ).catch((cause: unknown) => cause);

    // Then neither spelling silently degrades the remote source to a local miss
    expect(String(canonical)).toContain("unsupported remote source");
    expect(String(shorthand)).toContain("unsupported remote source");
  });

  test("strips control bytes authored into an include source", async () => {
    // Given a fragment path carrying a raw terminal escape sequence
    const failure = await resolve(
      { toolingIncludes: { ns: { file: "./\u001b[31mmissing.yml" } } },
      appRoot,
    ).catch((cause: unknown) => cause);

    // Then the rendered message cannot carry the escape into the terminal
    expect(String(failure)).not.toContain("\u001b");
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

  test("a tooling fragment carrying an unsupported task field is rejected with remediation", async () => {
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
