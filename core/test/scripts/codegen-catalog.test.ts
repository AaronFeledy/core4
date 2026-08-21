import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CatalogEntry = {
  readonly id: string;
  readonly ownership: "committed-pin" | "committed-workflow" | "derived";
  readonly script: string;
  readonly workspace: "core" | "repo";
  readonly dependsOn?: readonly string[];
};

type CodegenCommand = {
  readonly cmd: readonly string[];
  readonly cwd: string;
};

type CodegenCatalogModule = {
  readonly CODEGEN_CATALOG: readonly CatalogEntry[];
  readonly resolveCodegenCommand: (entry: CatalogEntry) => CodegenCommand;
  readonly groupCodegenWaves: (catalog?: readonly CatalogEntry[]) => readonly (readonly CatalogEntry[])[];
};

const isCodegenCatalogModule = (value: unknown): value is CodegenCatalogModule => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("CODEGEN_CATALOG" in value) ||
    !("resolveCodegenCommand" in value) ||
    !("groupCodegenWaves" in value) ||
    !Array.isArray(value.CODEGEN_CATALOG) ||
    typeof value.resolveCodegenCommand !== "function" ||
    typeof value.groupCodegenWaves !== "function"
  ) {
    return false;
  }

  return value.CODEGEN_CATALOG.every((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      !("ownership" in entry) ||
      !("script" in entry) ||
      !("workspace" in entry)
    ) {
      return false;
    }

    return (
      ["dependsOn,id,ownership,script,workspace", "id,ownership,script,workspace"].includes(
        Object.keys(entry).sort().join(","),
      ) &&
      typeof entry.id === "string" &&
      (!("dependsOn" in entry) ||
        (Array.isArray(entry.dependsOn) && entry.dependsOn.every((id: unknown) => typeof id === "string"))) &&
      (entry.ownership === "committed-pin" ||
        entry.ownership === "committed-workflow" ||
        entry.ownership === "derived") &&
      typeof entry.script === "string" &&
      (entry.workspace === "core" || entry.workspace === "repo")
    );
  });
};

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packageJson: unknown = await Bun.file(resolve(repositoryRoot, "package.json")).json();
const catalogModuleUrl = pathToFileURL(resolve(repositoryRoot, "scripts/codegen-catalog.ts")).href;
const importedCatalogModule: unknown = await import(catalogModuleUrl);
if (!isCodegenCatalogModule(importedCatalogModule)) {
  throw new TypeError("codegen catalog module does not satisfy its runtime contract");
}
const { CODEGEN_CATALOG, groupCodegenWaves, resolveCodegenCommand } = importedCatalogModule;
const catalog = CODEGEN_CATALOG;
const expectedCatalogRows = [
  ["build-guide-scenarios", "derived", "build-guide-scenarios.ts", "repo"],
  ["build-recipe-readmes", "derived", "build-recipe-readmes.ts", "repo"],
  ["bundled-plugins", "derived", "build-bundled-plugins.ts", "repo"],
  ["mutagen-versions", "committed-pin", "build-mutagen-versions.ts", "repo"],
  ["provider-images", "derived", "build-provider-images.ts", "repo"],
  ["compose-fixture-manifest", "derived", "build-compose-fixture-manifest.ts", "repo"],
  ["bundled-recipes", "derived", "build-bundled-recipes.ts", "repo"],
  ["bootstrap-layers", "derived", "build-bootstrap-layers.ts", "repo"],
  ["setup-plugin-flags", "derived", "build-setup-plugin-flags.ts", "repo"],
  ["mcp-allowlist", "derived", "build-mcp-allowlist.ts", "repo", ["setup-plugin-flags"]],
  [
    "host-proxy-allowlist",
    "derived",
    "build-host-proxy-allowlist.ts",
    "repo",
    ["setup-plugin-flags", "mcp-allowlist"],
  ],
  [
    "command-registry-manifest",
    "derived",
    "build-command-registry-manifest.ts",
    "core",
    ["setup-plugin-flags", "mcp-allowlist"],
  ],
  [
    "schema-snapshot",
    "derived",
    "build-schema-snapshot.ts",
    "repo",
    [
      "bundled-plugins",
      "bundled-recipes",
      "bootstrap-layers",
      "setup-plugin-flags",
      "mcp-allowlist",
      "host-proxy-allowlist",
      "command-registry-manifest",
    ],
  ],
  ["command-reference", "derived", "build-command-reference.ts", "repo", ["command-registry-manifest"]],
  ["compose-key-matrix", "derived", "build-compose-key-matrix.ts", "repo"],
  ["opentui-native-stubs", "derived", "build-opentui-native-stubs.ts", "repo"],
  ["php-base-images", "derived", "build-php-base-images.ts", "repo"],
  ["ci-workflow", "committed-workflow", "build-ci-workflow.ts", "repo"],
  ["nightly-workflow", "committed-workflow", "build-nightly-workflow.ts", "repo"],
  ["release-workflow", "committed-workflow", "build-release-workflow.ts", "repo"],
  ["provider-matrix-workflow", "committed-workflow", "build-provider-matrix-workflow.ts", "repo"],
  ["runtime-bundle-workflow", "committed-workflow", "build-runtime-bundle-workflow.ts", "repo"],
  ["php-base-workflow", "committed-workflow", "build-php-base-workflow.ts", "repo"],
  ["compose-vendor-bump-workflow", "committed-workflow", "build-compose-vendor-bump-workflow.ts", "repo"],
] as const;

describe("codegen catalog", () => {
  test("exposes focused guide scenario generation as a package command", () => {
    // Given
    const scripts =
      typeof packageJson === "object" && packageJson !== null && "scripts" in packageJson
        ? packageJson.scripts
        : undefined;

    // When
    const command =
      typeof scripts === "object" && scripts !== null && "codegen:guide-scenarios" in scripts
        ? scripts["codegen:guide-scenarios"]
        : undefined;

    // Then
    expect(command).toBe("bun run scripts/build-guide-scenarios.ts");
  });

  test("preserves the exact generator order, commands, and workspaces", () => {
    // Given
    const expectedWorkspaceRoots = {
      core: resolve(repositoryRoot, "core"),
      repo: repositoryRoot,
    } as const;
    const expectedCatalog = expectedCatalogRows.map((row) => {
      const [id, ownership, script, workspace, dependsOn] = row;
      return dependsOn === undefined
        ? { id, ownership, script, workspace }
        : { id, ownership, script, workspace, dependsOn };
    });
    const expectedCommands = expectedCatalogRows.map((row) => {
      const [, , script, workspace] = row;
      return {
        cmd: [process.execPath, "run", resolve(repositoryRoot, "scripts", script)],
        cwd: expectedWorkspaceRoots[workspace],
      };
    });

    // When
    const commands = catalog.map((entry) => resolveCodegenCommand(entry));

    // Then
    expect(catalog).toEqual(expectedCatalog);
    expect(catalog.map((entry) => Object.keys(entry).sort())).toEqual(
      expectedCatalog.map((entry) => Object.keys(entry).sort()),
    );
    expect(commands).toEqual(expectedCommands);
  });

  test("generates command graph prerequisites before schema artifacts", () => {
    // Given: schema generation imports the complete command and plugin graph.
    const prerequisiteIds = [
      "bundled-plugins",
      "bundled-recipes",
      "bootstrap-layers",
      "setup-plugin-flags",
      "mcp-allowlist",
      "host-proxy-allowlist",
      "command-registry-manifest",
    ] as const;

    // When: generator positions are compared with the schema generator.
    const schemaIndex = catalog.findIndex((entry) => entry.id === "schema-snapshot");

    // Then: every imported generated prerequisite already exists.
    for (const id of prerequisiteIds) {
      expect(catalog.findIndex((entry) => entry.id === id)).toBeLessThan(schemaIndex);
    }
  });

  test("classifies ownership and references unique existing scripts", async () => {
    // Given
    const expectedCommittedPins = ["mutagen-versions"];
    const expectedCommittedWorkflows = [
      "ci-workflow",
      "nightly-workflow",
      "release-workflow",
      "provider-matrix-workflow",
      "runtime-bundle-workflow",
      "php-base-workflow",
      "compose-vendor-bump-workflow",
    ];

    // When
    const ids = catalog.map((entry) => entry.id);
    const ownerships = catalog.map((entry) => entry.ownership);
    const scripts = catalog.map((entry) => entry.script);
    const existingScripts = await Promise.all(
      catalog.map((entry) => Bun.file(resolve(repositoryRoot, "scripts", entry.script)).exists()),
    );

    // Then
    expect(catalog).toHaveLength(24);
    expect(new Set(ids).size).toBe(catalog.length);
    expect(new Set(scripts).size).toBe(catalog.length);
    expect(existingScripts).toEqual(catalog.map(() => true));
    expect(ownerships.filter((ownership) => ownership === "committed-pin")).toHaveLength(1);
    expect(ownerships.filter((ownership) => ownership === "committed-workflow")).toHaveLength(7);
    expect(ownerships.filter((ownership) => ownership === "derived")).toHaveLength(16);
    expect(
      catalog.every((entry) => (entry.ownership === "committed-workflow") === entry.id.endsWith("-workflow")),
    ).toBe(true);
    expect(catalog.filter((entry) => entry.ownership === "committed-pin").map((entry) => entry.id)).toEqual(
      expectedCommittedPins,
    );
    expect(
      catalog.filter((entry) => entry.ownership === "committed-workflow").map((entry) => entry.id),
    ).toEqual(expectedCommittedWorkflows);
    expect(catalog.filter((entry) => entry.workspace === "core").map((entry) => entry.id)).toEqual([
      "command-registry-manifest",
    ]);
  });

  test("runs independent generators together and waits for explicit dependencies", () => {
    // Given / When
    const waves = groupCodegenWaves(catalog);
    const waveOf = (id: string): number => {
      const index = waves.findIndex((wave) => wave.some((entry) => entry.id === id));
      if (index === -1) throw new Error(`Missing catalog id ${id}`);
      return index;
    };

    // Then: later consumers wait for their inputs, and independent derived work shares a wave.
    expect(waveOf("command-registry-manifest")).toBeLessThan(waveOf("command-reference"));
    expect(waveOf("command-registry-manifest")).toBeLessThan(waveOf("schema-snapshot"));
    expect(waveOf("bundled-plugins")).toBeLessThan(waveOf("schema-snapshot"));
    expect(waveOf("setup-plugin-flags")).toBeLessThan(waveOf("mcp-allowlist"));
    expect(waveOf("setup-plugin-flags")).toBeLessThan(waveOf("host-proxy-allowlist"));
    expect(waveOf("setup-plugin-flags")).toBeLessThan(waveOf("command-registry-manifest"));
    expect(waveOf("mcp-allowlist")).toBeLessThan(waveOf("host-proxy-allowlist"));
    expect(waveOf("mcp-allowlist")).toBeLessThan(waveOf("command-registry-manifest"));
    expect(new Set(waves[0]?.map((entry) => entry.id))).toEqual(
      new Set(catalog.filter((entry) => (entry.dependsOn ?? []).length === 0).map((entry) => entry.id)),
    );
    expect(new Set(waves.flat().map((entry) => entry.id))).toEqual(new Set(catalog.map((entry) => entry.id)));
    expect(
      waves.every((wave) => {
        const indexes = wave.map((entry) => catalog.findIndex((candidate) => candidate.id === entry.id));
        return indexes.every((index, position) => position === 0 || index > (indexes[position - 1] ?? -1));
      }),
    ).toBe(true);
  });

  test("rejects unknown or cyclic codegen dependencies", () => {
    // Given
    const unknownDependency: CatalogEntry = {
      id: "broken",
      ownership: "derived",
      script: "missing.ts",
      workspace: "repo",
      dependsOn: ["does-not-exist"],
    };
    const cyclic: readonly CatalogEntry[] = [
      {
        id: "left",
        ownership: "derived",
        script: "left.ts",
        workspace: "repo",
        dependsOn: ["right"],
      },
      {
        id: "right",
        ownership: "derived",
        script: "right.ts",
        workspace: "repo",
        dependsOn: ["left"],
      },
    ];

    // When / Then
    expect(() => groupCodegenWaves([unknownDependency])).toThrow(/Unknown codegen dependency/);
    expect(() => groupCodegenWaves(cyclic)).toThrow(/Unresolvable codegen dependencies/);
  });

  test("imports without output or generator side effects", async () => {
    // Given
    const moduleUrls = ["codegen-catalog.ts", "codegen.ts"].map(
      (script) => pathToFileURL(resolve(repositoryRoot, "scripts", script)).href,
    );
    const children = moduleUrls.map((moduleUrl) =>
      Bun.spawn({
        cmd: [process.execPath, "-e", `await import(${JSON.stringify(moduleUrl)})`],
        cwd: resolve(repositoryRoot, "core"),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const timeout = setTimeout(() => {
      for (const child of children) child.kill();
    }, 8_000);

    try {
      // When
      const results = await Promise.all(
        children.map(async (child) => {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stderr, stdout };
        }),
      );

      // Then
      expect(results).toEqual(moduleUrls.map(() => ({ exitCode: 0, stderr: "", stdout: "" })));
    } finally {
      clearTimeout(timeout);
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  });
});
