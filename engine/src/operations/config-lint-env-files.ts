import { dirname, resolve } from "node:path";
import { parseEnvFile } from "@lando/landofile/env-file";
import { attributeEffectiveLintIssue } from "@lando/landofile/lint";
import type { ConfigLintViolation, LandofileShape } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect, Result } from "effect";

export const lintEnvFiles = Effect.fnUntraced(function* (
  landofile: LandofileShape,
  file: string,
  fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
) {
  const refs = [
    { path: ["env_file"], files: landofile.env_file ?? [] },
    ...Object.entries(landofile.services ?? {}).map(([name, service]) => ({
      path: ["services", name, "envFile"],
      files: service.envFile ?? [],
    })),
  ];
  const findings: ConfigLintViolation[] = [];
  const reads = new Map<string, ReturnType<Context.Service.Shape<typeof FileSystem>["readText"]>>();
  for (const ref of refs) {
    for (const [index, authoredPath] of ref.files.entries()) {
      const path = [...ref.path, index];
      const source = resolve(dirname(file), authoredPath);
      const attributed = attributeEffectiveLintIssue(landofile, {
        rule: "env-file.read",
        path,
        message: "",
      });
      if (fileSystem !== undefined && !reads.has(source)) {
        reads.set(source, yield* Effect.cached(fileSystem.readText(source)));
      }
      const read = reads.get(source);
      const content = read === undefined ? undefined : yield* read.pipe(Effect.result);
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
  return {
    findings,
    fileSystem:
      fileSystem === undefined
        ? undefined
        : {
            ...fileSystem,
            readText: (path: string) => reads.get(resolve(path)) ?? fileSystem.readText(path),
          },
  };
});
