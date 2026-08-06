import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";

import { resolveLandofileIncludes } from "../src/includes.ts";
import { makeTestLandofilePorts } from "./support.ts";

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

describe("tooling fragment validation", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "lando-tooling-fragment-validation-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  test("a tooling fragment rejects a nested canonical tooling include", async () => {
    // Given a tooling fragment with a nested canonical tooling include
    await writeFile(
      join(appRoot, "parent.yml"),
      ["includes:", "  - source: ./tasks.yml", "    kind: tooling", "    namespace: api", ""].join("\n"),
      "utf8",
    );

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then resolution fails closed with the include error contract
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test("a nested toolingIncludes entry names the unsupported field it declares", async () => {
    // Given a fragment whose nested include authors the pre-Beta-1 dir: field
    await writeFile(join(appRoot, "tasks.yml"), "tooling:\n  build:\n    cmd: build\n", "utf8");
    await writeFile(
      join(appRoot, "parent.yml"),
      ["toolingIncludes:", "  api:", "    file: ./tasks.yml", "    dir: ./api", ""].join("\n"),
      "utf8",
    );

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then the failure names the offending field rather than the fragment top-level-key contract
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") {
      expect(error.kind).toBe("forbidden-field");
      expect(error.message).toContain('"dir"');
      expect(error.message).toContain("toolingIncludes.api");
      expect(error.remediation).toContain("dir:");
    }
  });

  test("a fragment key that is also a rejected Compose key still fails as an include error", async () => {
    // Given a tooling fragment declaring a services block carrying a rejected Compose key
    await writeFile(
      join(appRoot, "parent.yml"),
      ["services:", "  web:", "    container_name: pinned", ""].join("\n"),
      "utf8",
    );

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then the fragment shape contract owns the failure instead of the Compose rejection surface
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test("a tooling fragment rejects a bare nested include", async () => {
    // Given a tooling fragment with an untyped nested include
    await writeFile(join(appRoot, "parent.yml"), "includes:\n  - ./tasks.yml\n", "utf8");

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then resolution fails closed with the include error contract
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test("a tooling fragment rejects a nested non-tooling include", async () => {
    // Given a tooling fragment with a nested Landofile include
    await writeFile(
      join(appRoot, "parent.yml"),
      ["includes:", "  - source: ./tasks.yml", "    kind: landofile", ""].join("\n"),
      "utf8",
    );

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then resolution fails closed with the include error contract
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test.each([
    ["path", { path: "tasks.yml" }],
    ["version", { version: "main" }],
    ["checksum", { checksum: "sha256:ignored" }],
  ] as const)("a canonical tooling include rejects the %s transport field", async (_field, transport) => {
    // Given a local tooling include carrying a transport-only field
    const landofile: LandofileShape = {
      includes: [
        {
          source: "./tasks.yml",
          kind: "tooling",
          namespace: "docs",
          ...transport,
        },
      ],
    };

    // When the include is resolved
    const error = await failure(landofile, appRoot);

    // Then the ignored field fails closed before the source is loaded
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test("a canonical tooling include rejects a remote source", async () => {
    // Given a tooling include with a remote source
    const landofile: LandofileShape = {
      includes: [
        {
          source: "https://example.com/tasks.yml",
          kind: "tooling",
          namespace: "docs",
        },
      ],
    };

    // When the include is resolved
    const error = await failure(landofile, appRoot);

    // Then the local-file-only contract fails closed without network access
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });

  test("a tooling fragment rejects a non-mapping toolingIncludes value", async () => {
    // Given a tooling fragment whose shorthand include collection is malformed
    await writeFile(join(appRoot, "parent.yml"), "toolingIncludes: false\n", "utf8");

    // When the fragment is resolved
    const error = await failure({ toolingIncludes: { docs: { file: "./parent.yml" } } }, appRoot);

    // Then the malformed collection fails instead of disappearing
    expect(error._tag).toBe("LandofileIncludeError");
    if (error._tag === "LandofileIncludeError") expect(error.kind).toBe("forbidden-field");
  });
});
