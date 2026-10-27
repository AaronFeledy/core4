#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { normalizeHostPlatform } from "@lando/paths";
import { Result, Schema } from "effect";
import { redactPublicTranscript } from "../core/src/docs/render/index.ts";
import { PublicTranscript } from "../sdk/src/docs/components/index.ts";
import { GuideId, type GuidePlatform } from "../sdk/src/docs/guide-frontmatter.ts";
import { discoverGuideMdxFiles } from "./guides/discovery.ts";
import type { GuideScenarioAst } from "./guides/model.ts";
import { parseGuideScenarioAst } from "./guides/parser.ts";
import {
  PUBLIC_TRANSCRIPT_REDACTION_ENV,
  buildPublicTranscript,
  publicTranscriptVariantSuffix,
} from "./guides/public-transcript.ts";
import { renderScenarioTest } from "./guides/test-render.ts";
import { variantsOf } from "./guides/variants.ts";

export type * from "./guides/model.ts";
export {
  parseGuideScenarioAst,
  buildPublicTranscript,
  publicTranscriptVariantSuffix,
  renderScenarioTest,
  variantsOf,
  discoverGuideMdxFiles,
};
export { publicTranscriptSuffixFromVariantString } from "./guides/public-transcript.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_GENERATED_GUIDE_TEST_ROOT = "test/scenarios/generated/guides";
const PUBLIC_TRANSCRIPT_ROOT = "dist/transcripts/public/guides";
export const resolveGeneratedGuideTestRoot = (
  configured = process.env.LANDO_DEV_GUIDES_GENERATED_ROOT,
  root = REPO_ROOT,
): string => {
  if (configured === undefined) return DEFAULT_GENERATED_GUIDE_TEST_ROOT;
  const cacheRoot = realpathSync(resolve(root, "node_modules/.cache"));
  const target = realpathSync(resolve(configured));
  const relativeTarget = relative(cacheRoot, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith("..") ||
    isAbsolute(relativeTarget) ||
    dirname(relativeTarget) !== "." ||
    !relativeTarget.startsWith("lando-dev-guides-generated-")
  )
    throw new Error(
      "LANDO_DEV_GUIDES_GENERATED_ROOT must name a direct lando-dev-guides-generated-* child of node_modules/.cache.",
    );
  return target;
};
const GENERATED_GUIDE_TEST_ROOT = resolveGeneratedGuideTestRoot();
export const resolveHostGuidePlatform = (
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): GuidePlatform => {
  const override = env.LANDO_GUIDE_SCENARIO_PLATFORM;
  switch (override) {
    case undefined:
      return normalizeHostPlatform({ env, platform });
    case "darwin":
    case "linux":
    case "win32":
    case "wsl":
      return override;
    default:
      throw new Error(`LANDO_GUIDE_SCENARIO_PLATFORM must be one of darwin|linux|win32|wsl: ${override}`);
  }
};
export interface BuildGuideScenarioOptions {
  readonly onlyGuide?: string;
}
interface EmitGuideScenarioOptions {
  readonly clearGuideId?: string;
}

export const buildGuideScenarioAst = async (
  root = REPO_ROOT,
  options: BuildGuideScenarioOptions = {},
): Promise<ReadonlyArray<GuideScenarioAst>> => {
  const files = await discoverGuideMdxFiles(root);
  const asts = await Promise.all(
    files.map(async (sourcePath) =>
      parseGuideScenarioAst(sourcePath, await Bun.file(resolve(root, sourcePath)).text()),
    ),
  );
  return asts
    .filter((guide) => options.onlyGuide === undefined || guide.frontmatter.id === options.onlyGuide)
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
};
export const publicTranscriptRelativePath = (
  guideId: string,
  scenarioId: string,
  variant: Parameters<typeof publicTranscriptVariantSuffix>[0],
  outputRoot = PUBLIC_TRANSCRIPT_ROOT,
): string => `${outputRoot}/${guideId}/${scenarioId}${publicTranscriptVariantSuffix(variant)}.json`;

export class UnsafeGuideIdError extends Schema.TaggedError<UnsafeGuideIdError>()("UnsafeGuideIdError", {
  message: Schema.String,
  guideId: Schema.String,
  remediation: Schema.String,
}) {}
export class UnsafeGuideClearTargetError extends Schema.TaggedError<UnsafeGuideClearTargetError>()(
  "UnsafeGuideClearTargetError",
  {
    message: Schema.String,
    target: Schema.String,
    root: Schema.String,
    remediation: Schema.String,
  },
) {}
export const decodeGuideIdArg = (value: string): typeof GuideId.Type => {
  const decoded = Schema.decodeUnknownResult(GuideId)(value);
  if (Result.isFailure(decoded))
    throw new UnsafeGuideIdError({
      message: `Invalid guide id: ${value}`,
      guideId: value,
      remediation:
        "Pass --only with a lowercase kebab-case guide id matching the GuideId schema (a-z, 0-9, hyphen).",
    });
  return decoded.success;
};
export const resolveContainedClearTarget = (
  root: string,
  outputRoot: string,
  clearGuideId: string | undefined,
): string => {
  const canonicalOutputRoot = resolve(root, outputRoot);
  if (clearGuideId === undefined || clearGuideId === "") return canonicalOutputRoot;
  const target = resolve(canonicalOutputRoot, decodeGuideIdArg(clearGuideId));
  const rel = relative(canonicalOutputRoot, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new UnsafeGuideClearTargetError({
      message: `Clear target escapes output root: ${target}`,
      target,
      root: canonicalOutputRoot,
      remediation: "Clear targets must resolve strictly under the canonical generated output root.",
    });
  return target;
};
export const emitPublicTranscripts = async (
  asts: ReadonlyArray<GuideScenarioAst>,
  root = REPO_ROOT,
  outputRoot = PUBLIC_TRANSCRIPT_ROOT,
  options: EmitGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> => {
  const outputs = asts.flatMap((guide) =>
    guide.scenarios.flatMap((scenario) =>
      variantsOf(guide).flatMap((variant) => {
        const transcript = buildPublicTranscript(guide, scenario, variant);
        return transcript === undefined
          ? []
          : [
              {
                path: publicTranscriptRelativePath(guide.frontmatter.id, scenario.id, variant, outputRoot),
                content: `${JSON.stringify(Schema.encodeSync(PublicTranscript)(redactPublicTranscript(transcript, PUBLIC_TRANSCRIPT_REDACTION_ENV)), null, 2)}\n`,
              },
            ];
      }),
    ),
  );
  await rm(resolveContainedClearTarget(root, outputRoot, options.clearGuideId), {
    force: true,
    recursive: true,
  });
  for (const output of outputs) {
    await mkdir(dirname(resolve(root, output.path)), { recursive: true });
    await Bun.write(resolve(root, output.path), output.content);
  }
  return outputs.map((output) => output.path).sort((a, b) => a.localeCompare(b));
};
export const emitGuideScenarioTests = async (
  asts: ReadonlyArray<GuideScenarioAst>,
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
  options: EmitGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> => {
  const platform = resolveHostGuidePlatform();
  const outputs = asts.flatMap((guide) =>
    guide.scenarios.flatMap((scenario) =>
      variantsOf(guide).map((variant) => ({
        path: `${outputRoot}/${guide.frontmatter.id}/${scenario.id}${publicTranscriptVariantSuffix(variant)}.test.ts`,
        content: renderScenarioTest(guide, scenario, variant, platform),
      })),
    ),
  );
  await rm(resolveContainedClearTarget(root, outputRoot, options.clearGuideId), {
    force: true,
    recursive: true,
  });
  for (const output of outputs) {
    await mkdir(dirname(resolve(root, output.path)), { recursive: true });
    await Bun.write(resolve(root, output.path), output.content);
  }
  return outputs.map((output) => output.path).sort((a, b) => a.localeCompare(b));
};
export const buildGuideScenarioTests = async (
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
  options: BuildGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> =>
  emitGuideScenarioTests(await buildGuideScenarioAst(root, options), root, outputRoot, {
    ...(options.onlyGuide === undefined ? {} : { clearGuideId: options.onlyGuide }),
  });
export const parseBuildGuideScenarioArgs = (args: ReadonlyArray<string>): BuildGuideScenarioOptions => {
  const options: { onlyGuide?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--only") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--only requires a guide id");
      options.onlyGuide = decodeGuideIdArg(value);
      index += 1;
    } else if (arg?.startsWith("--only=")) options.onlyGuide = decodeGuideIdArg(arg.slice("--only=".length));
    else throw new Error(`Unknown build-guide-scenarios flag: ${arg}`);
  }
  return options;
};
if (import.meta.main) {
  try {
    const options = parseBuildGuideScenarioArgs(Bun.argv.slice(2));
    const asts = await buildGuideScenarioAst(REPO_ROOT, options);
    const clearOptions = options.onlyGuide === undefined ? {} : { clearGuideId: options.onlyGuide };
    const written = await emitGuideScenarioTests(asts, REPO_ROOT, GENERATED_GUIDE_TEST_ROOT, clearOptions);
    await emitPublicTranscripts(asts, REPO_ROOT, PUBLIC_TRANSCRIPT_ROOT, clearOptions);
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`);
    process.exitCode = 1;
  }
}
