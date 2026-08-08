import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import ts from "typescript";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(import.meta.dirname, "../..");
const dependencyPackageRoot = resolve(repoRoot, "node_modules");
const packedConsumerDependencies = [
  ...Object.keys(corePackage.dependencies),
  "@standard-schema/spec",
  "fast-check",
  "pure-rand",
].toSorted();

const APP_HANDLE_EXPORTS = ["resolveApp", "openLandoRuntime", "makeLandoRuntime", "AppResolveError"] as const;

const sourceFile = async (path: string): Promise<ts.SourceFile> =>
  ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const descendants = (root: ts.Node): ReadonlyArray<ts.Node> => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
};

const exportedTypeMembers = (source: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue;
    if (!ts.isNamedExports(statement.exportClause) || !statement.isTypeOnly) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
};

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PWD: cwd },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const assertCommandSucceeded = (label: string, result: RunResult) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
};

describe("@lando/core App-handle entry export", () => {
  test("constructs the opaque App through the SDK brand applicator without assertions", async () => {
    // Given: the production App-handle and SDK contract syntax trees.
    const handle = await sourceFile(join(repoRoot, "engine/src/app/handle.ts"));
    const appContract = await sourceFile(join(repoRoot, "sdk/src/app/index.ts"));

    // When: handle construction and brand declarations are inspected structurally.
    const handleNodes = descendants(handle);
    const appContractNodes = descendants(appContract);
    // Then: the SDK applicator owns branding and the engine manufactures no asserted App value.
    expect(
      handleNodes.some((node) => ts.isCallExpression(node) && node.expression.getText(handle) === "brandApp"),
    ).toBe(true);
    expect(handleNodes.filter(ts.isAsExpression)).toHaveLength(0);
    expect(
      appContractNodes.some(
        (node) =>
          (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
          (node.name?.text === "brandApp" || node.name?.text === "AppImplementation"),
      ),
    ).toBe(true);
    expect(
      appContractNodes.some(
        (node) =>
          ts.isVariableDeclaration(node) &&
          node.name.getText(appContract) === "AppBrand" &&
          node.initializer !== undefined,
      ),
    ).toBe(true);
  });

  test("exports the App share and remote error contracts from the canonical root", async () => {
    // Given: the production root entry-point syntax tree.
    const entry = await sourceFile(join(coreRoot, "src/index.ts"));

    // When: type-only named exports are collected.
    const exports = exportedTypeMembers(entry);

    // Then: App consumers can name both canonical operation errors from @lando/core.
    expect(exports.has("ShareAppError")).toBe(true);
    expect(exports.has("RemoteSyncError")).toBe(true);
    expect(exports.has("ShareAppOptions")).toBe(true);
    expect(exports.has("ShareStopAppOptions")).toBe(true);
    expect(exports.has("ShareStopAppResult")).toBe(true);
  });

  test("type-checks the App share and remote contracts from the canonical root", async () => {
    // Given: an isolated TypeScript consumer resolving the workspace package root.
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-app-handle-types-"));
    try {
      await Bun.write(
        join(tempDir, "consumer.ts"),
        [
          'import type { RemoteSyncError, ShareAppError, ShareAppOptions, ShareStopAppOptions, ShareStopAppResult } from "@lando/core";',
          "declare const remoteError: RemoteSyncError;",
          "declare const shareError: ShareAppError;",
          "declare const shareOptions: ShareAppOptions;",
          "declare const shareStopOptions: ShareStopAppOptions;",
          "declare const shareStopResult: ShareStopAppResult;",
          "export const contracts = { remoteError, shareError, shareOptions, shareStopOptions, shareStopResult };",
        ].join("\n"),
      );
      await Bun.write(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({
          extends: join(repoRoot, "tsconfig.base.json"),
          compilerOptions: {
            baseUrl: repoRoot,
            declaration: false,
            declarationMap: false,
            emitDeclarationOnly: false,
            noEmit: true,
            paths: { "@lando/core": ["core/src/index.ts"] },
            typeRoots: [join(dependencyPackageRoot, "@types")],
          },
          include: ["consumer.ts"],
        }),
      );

      // When: TypeScript resolves the public type-only imports.
      const typecheck = await runCommand(
        [process.execPath, join(dependencyPackageRoot, "typescript/bin/tsc"), "-p", tempDir],
        tempDir,
      );

      // Then: the consumer compiles against the canonical core entry point.
      assertCommandSucceeded("@lando/core App-handle type imports", typecheck);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("keeps bound start and general share-stop channels exact", async () => {
    // Given: the bound start and general share operation syntax trees.
    const start = await sourceFile(join(repoRoot, "engine/src/operations/start.ts"));
    const share = await sourceFile(join(repoRoot, "engine/src/operations/share.ts"));

    // When: their declared requirement and error channels are resolved.
    const boundStartServices = start.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === "BoundStartAppServices",
    );
    const shareStop = descendants(share).find(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText(share) === "appShareStop",
    );
    const shareStopType =
      shareStop?.initializer !== undefined && ts.isArrowFunction(shareStop.initializer)
        ? shareStop.initializer.type?.getText(share)
        : undefined;

    // Then: the bound path excludes dead planning services and the general export stays precise.
    expect(boundStartServices?.type.getText(start)).toBe("Exclude<StartAppServices, LandofileService>");
    expect(shareStopType).toContain("ShareStopCommandError");
    expect(shareStopType).not.toContain("ShareAppError");
  });

  test("resolves resolveApp and openLandoRuntime from the workspace package", async () => {
    const mod = (await import("@lando/core")) as Record<string, unknown>;

    for (const name of APP_HANDLE_EXPORTS) {
      expect(mod[name], `@lando/core must export "${name}"`).toBeDefined();
    }
    expect(mod.resolveApp).toBeFunction();
    expect(mod.openLandoRuntime).toBeFunction();
    expect(await realpath(Bun.resolveSync("@lando/core", repoRoot))).toBe(
      await realpath(join(coreRoot, "src/index.ts")),
    );
  });

  test("resolves the packed root import using only declared non-plugin dependencies", async () => {
    // Given: a packed core package and a consumer containing only core's declared dependencies.
    const tempDir = await mkdtemp(join(tmpdir(), "lando-core-app-handle-export-"));

    try {
      const archivePath = join(tempDir, "lando-core-app-handle.tgz");
      const pack = await runCommand(
        [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
        coreRoot,
      );
      assertCommandSucceeded("bun pm pack", pack);

      const extractDir = join(tempDir, "extract");
      await mkdir(extractDir);
      const extract = await runCommand(
        ["tar", "-xzf", archivePath, "-C", extractDir, "package/package.json", "package/src"],
        tempDir,
      );
      assertCommandSucceeded("tar extract", extract);

      const consumerDir = join(tempDir, "consumer");
      const scopedDir = join(consumerDir, "node_modules/@lando");
      await mkdir(scopedDir, { recursive: true });
      await rename(join(extractDir, "package"), join(scopedDir, "core"));

      for (const dependency of packedConsumerDependencies) {
        const destination = join(consumerDir, "node_modules", dependency);
        await mkdir(dirname(destination), { recursive: true });
        await symlink(join(dependencyPackageRoot, dependency), destination, "dir");
      }

      const probe = [
        "const mod = await import('@lando/core');",
        `const names = ${JSON.stringify(APP_HANDLE_EXPORTS)};`,
        "const missing = names.filter((name) => typeof mod[name] !== 'function' && mod[name] === undefined);",
        "const notFn = ['resolveApp', 'openLandoRuntime'].filter((name) => typeof mod[name] !== 'function');",
        "console.log(JSON.stringify(missing));",
        "console.log(JSON.stringify(notFn));",
        "console.log(Bun.resolveSync('@lando/core', process.cwd()));",
        "process.exit(missing.length === 0 && notFn.length === 0 ? 0 : 1);",
      ].join("");

      // When: a preload-free Bun process imports the packed package root.
      const resolved = await runCommand([process.execPath, "-e", probe], consumerDir);

      // Then: the public App-handle API and packed root resolve without bundled plugin packages.
      assertCommandSucceeded("packed @lando/core App-handle import", resolved);
      expect(resolved.stderr).toBe("");

      const lines = resolved.stdout.trimEnd().split("\n");
      expect(JSON.parse(lines[0] ?? "[]")).toEqual([]);
      expect(JSON.parse(lines[1] ?? "[]")).toEqual([]);
      const resolvedPath = lines.at(-1);
      if (resolvedPath === undefined) throw new Error("packed import did not print a path");
      expect(await realpath(resolvedPath)).toBe(await realpath(join(scopedDir, "core/src/index.ts")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
