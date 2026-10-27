import { dirname, resolve } from "node:path";
import { parseEnvFile } from "@lando/landofile/env-file";
import { attributeEffectiveLintIssue } from "@lando/landofile/lint";
import type { ConfigLintViolation, LoadScopedLandofile } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";
import { Cache, type Context, Effect, Result } from "effect";

export const snapshotLintFileSystem = Effect.fnUntraced(function* (
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
) {
  if (fileSystem === undefined) return undefined;
  const reads = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (path: string) => fileSystem.readText(path),
  });
  return { ...fileSystem, readText: (path: string) => Cache.get(reads, resolve(path)) };
});

export const lintEnvFiles = Effect.fnUntraced(function* (
  compiled: Pick<LoadScopedLandofile, "document" | "pendingSites">,
  file: string,
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
  authored: LoadScopedLandofile["document"],
) {
  const landofile = compiled.document;
  const refs = [
    { path: ["env_file"], files: landofile.env_file ?? [] },
    ...Object.entries(landofile.services ?? {}).map(([name, service]) => ({
      path: ["services", name, "envFile"],
      files: service.envFile ?? [],
    })),
  ];
  const findings: ConfigLintViolation[] = [];
  for (const ref of refs) {
    for (const [index, authoredPath] of ref.files.entries()) {
      const path = [...ref.path, index];
      if (
        compiled.pendingSites.some(
          (site) =>
            site.path.every((part, position) => part === path[position]) ||
            path.every((part, position) => part === site.path[position]),
        )
      )
        continue;
      const source = resolve(dirname(file), authoredPath);
      const attributed = attributeEffectiveLintIssue(authored, {
        rule: "env-file.read",
        path,
        message: "",
      });
      const content =
        fileSystem === undefined ? undefined : yield* fileSystem.readText(source).pipe(Effect.result);
      if (content === undefined || Result.isFailure(content)) {
        findings.push({
          ...attributed,
          message: `Unable to read env file ${source}: ${content === undefined ? "FileSystem service is unavailable" : content.failure.message}. Create a readable env file at that path or remove it from env_file.`,
        });
        continue;
      }
      const parsed = parseEnvFile(content.success, source);
      if (!parsed.ok) {
        findings.push({
          ...attributed,
          rule: "env-file.syntax",
          message: `Invalid env file entry at ${source}:${parsed.issue.line}: ${parsed.issue.message}`,
          ...(parsed.issue.suggestion === undefined ? {} : { suggestion: parsed.issue.suggestion }),
        });
        continue;
      }
      for (const warning of parsed.warnings) {
        findings.push({
          ...attributed,
          rule: "env-file.literal",
          severity: "warning",
          message: `${source}:${warning.line}: ${warning.message}`,
          suggestion: warning.suggestion,
        });
      }
    }
  }
  return findings;
});
