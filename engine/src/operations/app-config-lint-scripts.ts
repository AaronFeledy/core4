import { dirname } from "node:path";
import { bunShellFrontMatterCoordinates, inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import type { ConfigLintViolation, LoadScopedLandofile } from "@lando/sdk/schema";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { bunShellScriptIssue } from "../services/bun-shell-dialect.ts";
import * as BunFileSystem from "../services/file-system.ts";

export const lintBunShellScripts = Effect.fn("AppOperation.configLintScripts")(function* (
  landofilePath: string,
  landofile: LoadScopedLandofile | undefined,
) {
  const inspection = yield* inspectBunShellScripts({ appRoot: dirname(landofilePath) });
  const fileSystem = yield* Effect.serviceOption(FileSystem);
  const findings: ConfigLintViolation[] = inspection.problems.map(
    ({ file, path, message, suggestion, line, column }) => ({
      rule: "script.front-matter",
      severity: "error",
      path,
      message,
      suggestion,
      source: { layer: "script", file, path },
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    }),
  );
  for (const script of inspection.scripts) {
    const read = yield* (
      Option.isSome(fileSystem)
        ? fileSystem.value.readText(script.path)
        : Effect.flatMap(FileSystem, (service) => service.readText(script.path)).pipe(
            Effect.provide(BunFileSystem.layer),
          )
    ).pipe(Effect.result);
    if (read._tag === "Failure") {
      findings.push({
        rule: "script.front-matter",
        severity: "error",
        path: [],
        source: { layer: "script", file: script.path, path: [] },
        message: `Cannot read script ${script.path}.`,
        suggestion: "Check that the script exists and is readable.",
      });
      continue;
    }
    if (script.service !== ":host")
      findings.push({
        rule: "script.front-matter",
        severity: "error",
        path: ["service"],
        source: { layer: "script", file: script.path, path: ["service"] },
        ...bunShellFrontMatterCoordinates(read.success, ["service"]),
        message: `.bun.sh service target ${script.service} is not supported.`,
        suggestion: "Use service: :host, or move this command to Landofile tooling to run it in a service.",
      });
    if (
      script.frontMatter.disabled === true ||
      (landofile !== undefined && Object.hasOwn(landofile.document.tooling ?? {}, script.name))
    )
      continue;
    const issue = bunShellScriptIssue(read.success);
    if (issue !== undefined)
      findings.push({
        rule: "script.host-shell",
        severity: "error",
        path: [],
        source: { layer: "script", file: script.path, path: [] },
        message: issue.message,
        suggestion: issue.suggestion,
        line: issue.line,
        column: issue.column,
      });
  }
  return findings;
});
