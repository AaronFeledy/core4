import { describe, expect, test } from "bun:test";
import { relative, resolve, sep } from "node:path";
import ts from "@typescript/typescript6";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("root typecheck coverage", () => {
  test("every tracked TypeScript file outside docs belongs to a project reachable from the root", () => {
    // Given: tracked TypeScript files and the root tsc -b project-reference graph.
    const tracked = Bun.spawnSync({
      cmd: ["git", "ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tracked.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${tracked.stderr.toString().trim()}`);
    }
    const rootConfig = resolve(repoRoot, "tsconfig.json");
    const configs = new Set([rootConfig]);
    const covered = new Set<string>();
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    };

    // When: TypeScript resolves every reachable project's inputs and references.
    for (const configPath of configs) {
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
      if (parsed === undefined) throw new Error(`Unable to parse ${configPath}`);
      const errors = parsed.errors.filter(
        (diagnostic) => !(configPath === rootConfig && diagnostic.code === 18003),
      );
      if (errors.length > 0) {
        throw new Error(
          `${configPath}:\n${errors
            .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
            .join("\n")}`,
        );
      }
      for (const fileName of parsed.fileNames) {
        covered.add(relative(repoRoot, resolve(fileName)).split(sep).join("/"));
      }
      for (const reference of parsed.projectReferences ?? []) {
        configs.add(resolve(ts.resolveProjectReferencePath(reference)));
      }
    }
    const uncovered = tracked.stdout
      .toString()
      .split("\0")
      .filter((path) => path.length > 0 && !path.startsWith("docs/") && !covered.has(path))
      .sort();

    // Then: the root typecheck graph covers every tracked non-Astro TypeScript file.
    expect(uncovered).toEqual([]);
  });
});
