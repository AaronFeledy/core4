#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseLandofile } from "../core/src/landofile/parser.ts";
import {
  type CleanupProps,
  type GuideFrontmatter,
  type InlineProps,
  type InspectProps,
  PublicTranscript,
  type RunProps,
  type UseFixtureProps,
  type VariableProps,
  type VerifyProps,
  assertAlpha2Component,
  decodeCleanupPropsEither,
  decodeGuideFrontmatterEither,
  decodeHiddenPropsEither,
  decodeInlinePropsEither,
  decodeInspectPropsEither,
  decodeRunPropsEither,
  decodeScenarioPropsEither,
  decodeSkipPropsEither,
  decodeStepPropsEither,
  decodeTabPropsEither,
  decodeTabsPropsEither,
  decodeUseFixturePropsEither,
  decodeVariablePropsEither,
  decodeVerifyPropsEither,
} from "../sdk/src/docs/components/index.ts";
import type { GuidePlatform } from "../sdk/src/docs/guide-frontmatter.ts";
import {
  GuideFrontmatterValidationError,
  GuideHiddenScenarioReasonError,
  NotImplementedError,
} from "../sdk/src/errors/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUIDE_ROOT = "docs/guides";
const GENERATED_GUIDE_TEST_ROOT = "test/scenarios/generated/guides";
const PUBLIC_TRANSCRIPT_ROOT = "dist/transcripts/public/guides";

const isNotFound = (cause: unknown): boolean =>
  cause !== null && typeof cause === "object" && (cause as { code?: unknown }).code === "ENOENT";

const GUIDE_PLATFORMS: ReadonlyArray<GuidePlatform> = ["darwin", "linux", "win32", "wsl"];

export const resolveHostGuidePlatform = (
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): GuidePlatform => {
  const override = env.LANDO_GUIDE_SCENARIO_PLATFORM;
  if (override !== undefined) {
    if (GUIDE_PLATFORMS.includes(override as GuidePlatform)) return override as GuidePlatform;
    throw new Error(`LANDO_GUIDE_SCENARIO_PLATFORM must be one of ${GUIDE_PLATFORMS.join("|")}: ${override}`);
  }
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  if (platform === "linux" && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined))
    return "wsl";
  return "linux";
};

// A WSL host executes the same Linux build, so it also satisfies guides that allow-list `linux`.
const platformsSatisfiedByHost = (host: GuidePlatform): ReadonlyArray<GuidePlatform> =>
  host === "wsl" ? ["wsl", "linux"] : [host];

export type GuideStepComponent =
  | { readonly kind: "Run"; readonly props: RunProps; readonly line: number }
  | { readonly kind: "Verify"; readonly props: VerifyProps; readonly line: number }
  | { readonly kind: "Cleanup"; readonly props: CleanupProps; readonly line: number }
  | { readonly kind: "Variable"; readonly props: VariableProps; readonly line: number }
  | { readonly kind: "UseFixture"; readonly props: UseFixtureProps; readonly line: number }
  | { readonly kind: "Inspect"; readonly props: InspectProps; readonly line: number }
  | { readonly kind: "Inline"; readonly props: InlineProps; readonly line: number };

export interface GuideStepNode {
  readonly stepName: string;
  readonly line: number;
  readonly hidden: boolean;
  readonly hiddenReason?: string;
  readonly components: ReadonlyArray<GuideStepComponent>;
}

export interface GuideTabNode {
  readonly name: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}

export interface GuideTabsBlock {
  readonly kind: "tabs";
  readonly axis: string;
  readonly line: number;
  readonly tabs: ReadonlyArray<GuideTabNode>;
}

export interface GuideHiddenBlock {
  readonly kind: "hidden";
  readonly reason: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}

export interface GuideSkipBlock {
  readonly kind: "skip";
  readonly reason: string;
  readonly until?: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}

export type GuideScenarioBodyItem =
  | { readonly kind: "step"; readonly step: GuideStepNode }
  | GuideTabsBlock
  | GuideHiddenBlock
  | GuideSkipBlock;

export interface GuideScenarioNode {
  readonly id: string;
  readonly render: boolean;
  readonly reason?: string;
  readonly layer?: "scenario" | "e2e";
  readonly tags?: ReadonlyArray<string>;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
  readonly body: ReadonlyArray<GuideScenarioBodyItem>;
}

const DEFAULT_AXIS = "default";

export interface GuideVariantPair {
  readonly axis: string;
  readonly value: string;
}

export interface GuideVariant {
  readonly pairs: ReadonlyArray<GuideVariantPair>;
  readonly skip?: { readonly reason: string; readonly until?: string };
  readonly tags?: ReadonlyArray<string>;
  readonly platforms?: ReadonlyArray<GuidePlatform>;
}

interface ResolvedVariantSteps {
  readonly steps: ReadonlyArray<GuideStepNode>;
  readonly skips: ReadonlyArray<{ readonly stepName: string; readonly reason: string }>;
}

export interface GuideScenarioAst {
  readonly sourcePath: string;
  readonly frontmatter: GuideFrontmatter;
  readonly guideLine: number;
  readonly scenarios: ReadonlyArray<GuideScenarioNode>;
}

export interface BuildGuideScenarioOptions {
  readonly onlyGuide?: string;
}

interface EmitGuideScenarioOptions {
  readonly clearGuideId?: string;
}

type MdxNode = {
  readonly type: string;
  readonly name?: string | null;
  readonly value?: unknown;
  readonly attributes?: ReadonlyArray<MdxAttribute>;
  readonly children?: ReadonlyArray<MdxNode>;
  readonly position?: { readonly start?: { readonly line?: number } };
};

type MdxAttribute = {
  readonly type: string;
  readonly name?: string;
  readonly value?:
    | string
    | null
    | { readonly type?: string; readonly value?: string; readonly data?: unknown };
};

const processor = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter, ["yaml"]);

const lineOf = (node: MdxNode): number => node.position?.start?.line ?? 1;

const quote = (value: string): string => JSON.stringify(value);

const interpolate = (value: string, variables: ReadonlyMap<string, VariableProps>): string =>
  value.replace(/\{\{\s*([A-Za-z_$][\w$-]*)\s*\}\}/g, (_match, name: string) => {
    const variable = variables.get(name);
    return variable?.value ?? "";
  });

const sourceComment = (sourcePath: string, line: number): string => `  // @source: ${sourcePath}:${line}`;

const isLibraryRunProps = (props: RunProps): props is Extract<RunProps, { runtime: "library" }> =>
  "runtime" in props && props.runtime === "library";

const assertScenarioRunMode = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  steps: ReadonlyArray<GuideStepNode>,
): "cli" | "library" => {
  let hasCli = false;
  let hasLibrary = false;
  for (const step of steps) {
    for (const component of step.components) {
      if (component.kind !== "Run") continue;
      if (isLibraryRunProps(component.props)) hasLibrary = true;
      else hasCli = true;
    }
  }
  if (hasCli && hasLibrary) {
    throw new Error(
      `Guide ${guide.sourcePath} scenario ${guide.frontmatter.id}:${scenario.id} mixes cli/shell and library <Run> steps; mixed runtime scenarios are not supported.`,
    );
  }
  return hasLibrary ? "library" : "cli";
};

const collectVariables = (steps: ReadonlyArray<GuideStepNode>): ReadonlyMap<string, VariableProps> => {
  const variables = new Map<string, VariableProps>();
  for (const step of steps) {
    for (const component of step.components) {
      if (component.kind === "Variable") variables.set(component.props.name, component.props);
    }
  }
  return variables;
};

const axisEntriesOf = (
  frontmatter: GuideFrontmatter,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
  if (frontmatter.tabs !== undefined && frontmatter.tabs.length > 0) {
    return [[DEFAULT_AXIS, frontmatter.tabs]];
  }
  if (frontmatter.axes !== undefined) return Object.entries(frontmatter.axes);
  return [];
};

export const variantsOf = (guide: GuideScenarioAst): ReadonlyArray<GuideVariant | undefined> => {
  const entries = axisEntriesOf(guide.frontmatter);
  if (entries.length === 0) return [undefined];
  let combinations: ReadonlyArray<ReadonlyArray<GuideVariantPair>> = [[]];
  for (const [axis, values] of entries) {
    combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, { axis, value }]));
  }
  const overrides = guide.frontmatter.variants ?? {};
  const guideTags = guide.frontmatter.tags ?? [];
  return combinations.map((pairs) => {
    const override = overrides[pairs.map((pair) => pair.value).join(".")];
    const skip = override?.skip ?? guide.frontmatter.skip;
    const tags =
      override?.tags === undefined
        ? guideTags.length === 0
          ? undefined
          : guideTags
        : [...new Set([...guideTags, ...override.tags])];
    return {
      pairs,
      ...(skip === undefined ? {} : { skip }),
      ...(tags === undefined ? {} : { tags }),
      ...(override?.platforms === undefined
        ? guide.frontmatter.platforms === undefined
          ? {}
          : { platforms: guide.frontmatter.platforms }
        : { platforms: override.platforms }),
    };
  });
};

const blockStepUnion = (block: GuideTabsBlock): ReadonlyArray<string> => {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const tab of block.tabs) {
    for (const step of tab.steps) {
      if (seen.has(step.stepName)) continue;
      seen.add(step.stepName);
      union.push(step.stepName);
    }
  }
  return union;
};

const effectiveAxisOf = (block: GuideTabsBlock, variant: GuideVariant): string => {
  const [first] = variant.pairs;
  if (block.axis === DEFAULT_AXIS && variant.pairs.length === 1 && first !== undefined) return first.axis;
  return block.axis;
};

const resolveVariantSteps = (
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
): ResolvedVariantSteps => {
  const steps: GuideStepNode[] = [];
  const skips: Array<{ stepName: string; reason: string }> = [];
  for (const item of scenario.body) {
    if (item.kind === "step") {
      steps.push(item.step);
      continue;
    }
    if (item.kind === "hidden") {
      for (const step of item.steps) steps.push(step);
      continue;
    }
    if (item.kind === "skip") {
      for (const step of item.steps) skips.push({ stepName: step.stepName, reason: item.reason });
      continue;
    }
    const union = blockStepUnion(item);
    const axis = variant === undefined ? item.axis : effectiveAxisOf(item, variant);
    const value = variant?.pairs.find((pair) => pair.axis === axis)?.value;
    const matched = value === undefined ? undefined : item.tabs.find((tab) => tab.name === value);
    for (const stepName of union) {
      const step =
        variant === undefined
          ? item.tabs.flatMap((tab) => tab.steps).find((candidate) => candidate.stepName === stepName)
          : matched?.steps.find((candidate) => candidate.stepName === stepName);
      if (step !== undefined) {
        steps.push(step);
        continue;
      }
      if (variant !== undefined) {
        skips.push({
          stepName,
          reason: `axis ${axis}=${value ?? ""} tab does not include step ${stepName}`,
        });
      }
    }
  }
  return { steps, skips };
};

const renderMatcher = (value: unknown): string => JSON.stringify(value, null, 2);

const renderVariableSetup = (variables: ReadonlyMap<string, VariableProps>): string =>
  [...variables.values()]
    .map((variable) => {
      const display =
        variable.display === undefined ? "" : `\n    // @display: ${variable.name} = ${variable.display}`;
      return `${display}\n    context.vars.set(${quote(variable.name)}, { value: ${quote(variable.value)}${
        variable.display === undefined ? "" : `, display: ${quote(variable.display)}`
      } });`;
    })
    .join("\n");

const renderCleanupFinalizers = (steps: ReadonlyArray<GuideStepNode>, sourcePath: string): string =>
  steps
    .flatMap((step) =>
      step.components
        .filter((component) => component.kind === "Cleanup")
        .map((component) => ({ component, hidden: step.hidden })),
    )
    .map(({ component, hidden }) => {
      // Hidden-origin cleanup finalizers run at teardown where hiddenDepth is 0, so
      // re-enter context.hidden to keep their frame suppressed.
      const append = `context.transcript.append({ kind: "cleanup", command: [], exit: 0 })`;
      const finalizer = hidden ? `context.hidden(${append})` : append;
      return `${sourceComment(sourcePath, component.line)}\n    yield* Effect.addFinalizer(() => ${finalizer});`;
    })
    .join("\n");

const indentLibraryCode = (code: string): string =>
  code
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

const renderRun = (
  component: Extract<GuideStepComponent, { kind: "Run" }>,
  variables: ReadonlyMap<string, VariableProps>,
  sourcePath: string,
): string => {
  if (isLibraryRunProps(component.props)) {
    return [
      sourceComment(sourcePath, component.line),
      "    {",
      "      void LandoCore;",
      "      void LandoTesting;",
      indentLibraryCode(component.props.code),
      "    }",
    ].join("\n");
  }
  if ("command" in component.props) {
    const answers = component.props.answers ?? {};
    return [
      `    const runAttempt = yield* Effect.either(context.runCli(${quote(interpolate(component.props.command, variables))}, {`,
      `      answers: ${JSON.stringify(answers)},`,
      "    }));",
      "    if (Either.isLeft(runAttempt)) {",
      "      lastFailure = runAttempt.left;",
      "    } else {",
      "      lastRun = runAttempt.right;",
      `      expect(runAttempt.right.exitCode).toBe(${component.props.expectExit ?? 0});`,
      "    }",
    ].join("\n");
  }
  return `    yield* context.shell(${quote("shell" in component.props ? component.props.shell : "")});`;
};

const renderVerify = (
  component: Extract<GuideStepComponent, { kind: "Verify" }>,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  const expected = component.props.expect === undefined ? undefined : renderMatcher(component.props.expect);
  if (component.props.event !== undefined) {
    const actual = `context.events.find((event) => event._tag === ${quote(component.props.event)})`;
    return [
      `    const actual = ${actual};`,
      `    const matched = ${expected === undefined ? "actual !== undefined" : `matchesExpected(actual, ${expected})`};`,
      `    yield* context.transcript.append({ kind: "verify", target: "event", matched, expected: ${expected ?? quote(component.props.event)}, actual });`,
      "    expect(matched).toBe(true);",
    ].join("\n");
  }
  if (component.props.command !== undefined) {
    const command = component.props.command;
    return [
      `    const verifyRun = yield* context.runCli(${quote(interpolate(command, variables))});`,
      "    expect(verifyRun.exitCode).toBe(0);",
      ...(expected === undefined
        ? []
        : [
            `    expect(matchesExpected({ stdout: verifyRun.stdout, stderr: verifyRun.stderr }, ${expected})).toBe(true);`,
          ]),
    ].join("\n");
  }
  if (component.props.file !== undefined) {
    const filePath = interpolate(component.props.file, variables);
    return [
      `    const fileContent = yield* Effect.promise(() => Bun.file(join(context.testDir, ${quote(filePath)})).text());`,
      `    const matched = ${expected === undefined ? "fileContent !== undefined" : `matchesExpected(fileContent, ${expected})`};`,
      `    yield* context.transcript.append({ kind: "verify", target: "file", matched, expected: ${expected ?? quote(filePath)}, actual: fileContent });`,
      "    expect(matched).toBe(true);",
    ].join("\n");
  }
  return [
    "    const failureForErrorTag = lastFailure ?? lastRun;",
    '    const failureText = typeof failureForErrorTag === "string" ? failureForErrorTag : JSON.stringify(failureForErrorTag);',
    "    const actual = (failureForErrorTag as { _tag?: string })?._tag ?? failureText;",
    `    const matched = actual.includes(${quote(component.props.errorTag ?? "")})${
      expected === undefined ? "" : ` && matchesExpected(failureText, ${expected})`
    };`,
    `    yield* context.transcript.append({ kind: "verify", target: "errorTag", matched, expected: ${quote(component.props.errorTag ?? "")}, actual });`,
    "    expect(matched).toBe(true);",
  ].join("\n");
};

const renderInspect = (
  component: Extract<GuideStepComponent, { kind: "Inspect" }>,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  const props = component.props;
  const arg =
    props.file !== undefined
      ? `{ file: ${quote(interpolate(props.file, variables))} }`
      : props.json !== undefined
        ? `{ json: ${quote(interpolate(props.json, variables))} }`
        : props.events === true
          ? "{ events: true }"
          : "{ output: true }";
  return `    yield* context.inspect(${arg});`;
};

const renderInline = (component: Extract<GuideStepComponent, { kind: "Inline" }>): string =>
  `    yield* context.transcript.append({ kind: "inline", lang: ${quote(component.props.lang)}, code: ${quote(component.props.code)} });`;

const renderStepComponent = (
  component: GuideStepComponent,
  sourcePath: string,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  if (component.kind === "Variable" || component.kind === "Cleanup") return "";
  if (component.kind === "Run" && isLibraryRunProps(component.props)) {
    return renderRun(component, variables, sourcePath);
  }
  const body = (() => {
    switch (component.kind) {
      case "Run":
        return renderRun(component, variables, sourcePath);
      case "Verify":
        return renderVerify(component, variables);
      case "UseFixture":
        return `    yield* context.fixtures.use(${quote(component.props.name)});`;
      case "Inspect":
        return renderInspect(component, variables);
      case "Inline":
        return renderInline(component);
    }
  })();
  return `${sourceComment(sourcePath, component.line)}\n    {\n${body}\n    }`;
};

const renderSkips = (skips: ResolvedVariantSteps["skips"]): string =>
  skips.map((skip) => `// @skip: ${skip.reason}\ntest.skip(${quote(skip.stepName)}, () => {});`).join("\n");

const effectiveScenarioLayer = (guide: GuideScenarioAst, scenario: GuideScenarioNode): "scenario" | "e2e" =>
  scenario.layer ?? guide.frontmatter.defaultLayer ?? "scenario";

const effectiveScenarioTags = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
): ReadonlyArray<string> => [
  ...new Set([...(variant?.tags ?? guide.frontmatter.tags ?? []), ...(scenario.tags ?? [])]),
];

const variantTestNameLabel = (variant: GuideVariant | undefined): string => {
  if (variant === undefined || variant.pairs.length === 0) return "";
  const pairs = [...variant.pairs]
    .sort((left, right) => left.axis.localeCompare(right.axis))
    .map((pair) => `${pair.axis}=${pair.value}`)
    .join(" ");
  return ` (${pairs})`;
};

const renderScenarioTest = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
  hostPlatform: GuidePlatform,
): string => {
  const resolved = resolveVariantSteps(scenario, variant);
  const runMode = assertScenarioRunMode(guide, scenario, resolved.steps);
  const scenarioLayer = effectiveScenarioLayer(guide, scenario);
  if (scenarioLayer === "e2e" && runMode === "library") {
    throw new Error(
      `Guide ${guide.sourcePath} scenario ${guide.frontmatter.id}:${scenario.id} declares layer e2e with library <Run> steps; e2e guide scenarios must drive the CLI.`,
    );
  }
  const usesLibraryRuntime = runMode === "library";
  const usesE2eRuntime = scenarioLayer === "e2e";
  const variables = collectVariables(resolved.steps);
  const variableSetup = renderVariableSetup(variables);
  const cleanupFinalizers = renderCleanupFinalizers(resolved.steps, guide.sourcePath);
  const steps = resolved.steps
    .map((step) => {
      const components = step.components
        .map((component) => renderStepComponent(component, guide.sourcePath, variables))
        .filter(Boolean)
        .join("\n");
      const header = `${sourceComment(guide.sourcePath, step.line)}\n    // @step: ${step.stepName}`;
      if (step.hidden) {
        const hiddenHeader = `${header}\n    // @hidden: ${step.hiddenReason ?? ""}`;
        return components === ""
          ? hiddenHeader
          : `${hiddenHeader}\n    yield* context.hidden(Effect.gen(function* () {\n${components}\n    }));`;
      }
      return `${header}${components === "" ? "" : `\n${components}`}`;
    })
    .join("\n");
  const variantHeader =
    variant === undefined
      ? "// @variant:"
      : `// @variant: ${variant.pairs.map((pair) => `${pair.axis}=${pair.value}`).join(" ")}`;
  const effectiveTags = effectiveScenarioTags(guide, scenario, variant);
  const effectivePlatforms = variant?.platforms ?? guide.frontmatter.platforms;
  const platformSkip =
    effectivePlatforms !== undefined &&
    effectivePlatforms.length > 0 &&
    !platformsSatisfiedByHost(hostPlatform).some((p) => effectivePlatforms.includes(p))
      ? `skipped on ${hostPlatform}: requires platform [${effectivePlatforms.join(",")}]`
      : undefined;
  const annotationLines = [
    ...(effectiveTags.length === 0 ? [] : [`// @tags: ${effectiveTags.join(",")}`]),
    ...(usesE2eRuntime ? ["// @layer: e2e"] : []),
    ...(effectivePlatforms === undefined ? [] : [`// @platforms: ${effectivePlatforms.join(",")}`]),
    ...(variant?.skip === undefined ? [] : [`// @variant-skip: ${variant.skip.reason}`]),
  ];
  const variantAnnotations = annotationLines.length === 0 ? "" : `\n${annotationLines.join("\n")}`;
  const skips = variant?.skip === undefined ? renderSkips(resolved.skips) : "";
  const forcedSkip = variant?.skip !== undefined || platformSkip !== undefined;
  const testFn = forcedSkip ? "test.skip" : "test";
  const taggedTestName = `${effectiveTags.length === 0 ? "" : `${effectiveTags.join(" ")} `}${guide.frontmatter.id}:${scenario.id}${variantTestNameLabel(variant)}${
    usesE2eRuntime ? " [e2e]" : ""
  }`;
  const runnableTestName = quote(
    platformSkip === undefined ? taggedTestName : `${taggedTestName} (${platformSkip})`,
  );
  const skippedE2eTestName = quote(
    `${taggedTestName} (skipped: set LANDO_GUIDE_E2E=1, LANDO_SCENARIO_E2E_BINARY, and LANDO_TEST_PODMAN_SOCKET to run e2e guide scenarios)`,
  );
  const e2eForcedSkip = usesE2eRuntime && testFn === "test.skip";
  const testNameExpression =
    usesE2eRuntime && !e2eForcedSkip
      ? `(e2eGateEnabled ? ${runnableTestName} : ${skippedE2eTestName})`
      : runnableTestName;
  const testFnExpression = usesE2eRuntime
    ? e2eForcedSkip
      ? "test.skip"
      : "(e2eGateEnabled ? test : test.skip)"
    : testFn;
  const testTimeoutArg = usesE2eRuntime ? `, ${guide.frontmatter.timeout}` : "";
  const contextRunner = usesE2eRuntime
    ? "ScenarioContextFactory.e2e"
    : usesLibraryRuntime
      ? "LandoTesting.withScenarioContext"
      : "withScenarioContext";

  return `// @generated
// @source: ${guide.sourcePath}:${scenario.line}
// @scenario: ${scenario.id}
${scenario.render === false ? "// @render: false\n" : ""}${variantHeader}${variantAnnotations}

import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Either } from "effect";
${
  usesLibraryRuntime
    ? 'import * as LandoCore from "@lando/core";\nimport * as LandoTesting from "@lando/core/testing";'
    : usesE2eRuntime
      ? 'import { ScenarioContextFactory } from "@lando/core/testing";'
      : 'import { withScenarioContext } from "@lando/core/testing";'
}

${
  usesE2eRuntime
    ? 'const e2eGateEnabled = process.env.LANDO_GUIDE_E2E === "1" && process.env.LANDO_SCENARIO_E2E_BINARY !== undefined && process.env.LANDO_TEST_PODMAN_SOCKET !== undefined;'
    : ""
}

const matchesExpected = (actual: unknown, expected: unknown): boolean => {
  if (expected === undefined) return actual !== undefined;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => matchesExpected(actual[index], value));
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const record = expected as Record<string, unknown>;
    if (typeof record.regex === "string") return new RegExp(record.regex).test(String(actual));
    if (typeof record.schema === "string") return actual !== undefined;
    if (Array.isArray(record.anyOf)) return record.anyOf.some((item) => matchesExpected(actual, item));
    if (Object.hasOwn(record, "not")) return !matchesExpected(actual, record.not);
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(record).every(([key, value]) => matchesExpected((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
};

${testFnExpression}(${testNameExpression}, async () => {
  await Effect.runPromise(
    ${contextRunner}({ guideId: ${quote(guide.frontmatter.id)}, scenarioId: ${quote(scenario.id)}, render: ${scenario.render} }, (context) =>
      Effect.gen(function* () {
        let lastRun: unknown;
        let lastFailure: unknown;
${variableSetup === "" ? "" : `${variableSetup}\n`}${cleanupFinalizers === "" ? "" : `${cleanupFinalizers}\n`}${steps}
      }),
    ),
  );
}${testTimeoutArg});
${skips === "" ? "" : `\n${skips}\n`}`;
};

const parseFrontmatter = (sourcePath: string, yaml: string | undefined): Record<string, unknown> => {
  if (yaml === undefined) return {};
  try {
    const parsed = Effect.runSync(
      parseLandofile({ file: sourcePath, content: yaml, cwd: dirname(sourcePath) }),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new GuideFrontmatterValidationError({
      message: `Invalid guide frontmatter at ${sourcePath}.`,
      sourcePath,
      field: "frontmatter",
      rejectedValue: yaml,
      issues: [String(error)],
      remediation: `Fix the YAML frontmatter in ${sourcePath}.`,
    });
  }
};

const firstYaml = (root: MdxNode): string | undefined =>
  root.children?.find((child) => child.type === "yaml")?.value as string | undefined;

const expressionToValue = (expression: string): unknown => {
  const trimmed = expression.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const withoutEscapes = trimmed.replace(/\\./g, "");
    if (withoutEscapes.includes("${")) {
      throw new Error(
        "Template literal interpolation is not allowed in guide props; use a literal backtick string without `${...}`.",
      );
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const jsonish = trimmed.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"');
    return JSON.parse(jsonish) as unknown;
  }
  throw new Error(`Unsupported MDX attribute expression: ${expression}`);
};

const propsOf = (node: MdxNode): Record<string, unknown> => {
  const props: Record<string, unknown> = {};
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== "mdxJsxAttribute" || attribute.name === undefined) continue;
    if (attribute.value === null || attribute.value === undefined) {
      props[attribute.name] = true;
    } else if (typeof attribute.value === "string") {
      props[attribute.name] = attribute.value;
    } else {
      props[attribute.name] = expressionToValue(attribute.value.value ?? "");
    }
  }
  return props;
};

const decodeOrThrow = <A>(
  either: Either.Either<A, unknown>,
  sourcePath: string,
  component: string,
  props: Record<string, unknown>,
): A => {
  if (Either.isRight(either)) return either.right;
  if (either.left instanceof NotImplementedError) throw either.left;
  const firstField = Object.keys(props).sort()[0] ?? component;
  throw new GuideFrontmatterValidationError({
    message: `<${component}> props are invalid at ${sourcePath}.`,
    sourcePath,
    field: firstField,
    rejectedValue: props[firstField],
    issues: [String(either.left)],
    remediation: `Fix <${component}> prop \`${firstField}\` in ${sourcePath}.`,
  });
};

const fieldFromParseIssue = (issue: string): string => {
  const match = /\["([^\"]+)"\]/.exec(issue);
  return match?.[1] ?? "frontmatter";
};

const decodeFrontmatter = (sourcePath: string, input: Record<string, unknown>): GuideFrontmatter => {
  const decoded = decodeGuideFrontmatterEither(input);
  if (Either.isRight(decoded)) return decoded.right;
  if (decoded.left instanceof NotImplementedError) throw decoded.left;
  const issue = String(decoded.left);
  const firstField = fieldFromParseIssue(issue);
  throw new GuideFrontmatterValidationError({
    message: `Guide frontmatter is invalid at ${sourcePath}.`,
    sourcePath,
    field: firstField,
    rejectedValue: input[firstField],
    issues: [issue],
    remediation: `Fix guide frontmatter field \`${firstField}\` with rejected value ${JSON.stringify(input[firstField])}.`,
  });
};

const elementChildren = (node: MdxNode): ReadonlyArray<MdxNode> =>
  (node.children ?? []).filter((child) => child.type === "mdxJsxFlowElement");

const parseStepComponent = (node: MdxNode, sourcePath: string): GuideStepComponent | undefined => {
  if (node.name === undefined || node.name === null) return undefined;
  assertAlpha2Component(node.name, sourcePath);
  const props = propsOf(node);
  const line = lineOf(node);
  switch (node.name) {
    case "Run":
      return {
        kind: "Run",
        props: decodeOrThrow(decodeRunPropsEither(props), sourcePath, "Run", props),
        line,
      };
    case "Verify":
      return {
        kind: "Verify",
        props: decodeOrThrow(decodeVerifyPropsEither(props), sourcePath, "Verify", props),
        line,
      };
    case "Cleanup":
      return {
        kind: "Cleanup",
        props: decodeOrThrow(decodeCleanupPropsEither(props), sourcePath, "Cleanup", props),
        line,
      };
    case "Variable":
      return {
        kind: "Variable",
        props: decodeOrThrow(decodeVariablePropsEither(props), sourcePath, "Variable", props),
        line,
      };
    case "UseFixture":
      return {
        kind: "UseFixture",
        props: decodeOrThrow(decodeUseFixturePropsEither(props), sourcePath, "UseFixture", props),
        line,
      };
    case "Inspect":
      return {
        kind: "Inspect",
        props: decodeOrThrow(decodeInspectPropsEither(props), sourcePath, "Inspect", props),
        line,
      };
    case "Inline":
      return {
        kind: "Inline",
        props: decodeOrThrow(decodeInlinePropsEither(props), sourcePath, "Inline", props),
        line,
      };
    default:
      return undefined;
  }
};

const parseStep = (node: MdxNode, sourcePath: string, hiddenReason?: string): GuideStepNode => {
  assertAlpha2Component("Step", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeStepPropsEither(rawProps), sourcePath, "Step", rawProps);
  const components = elementChildren(node)
    .map((child) => parseStepComponent(child, sourcePath))
    .filter((component): component is GuideStepComponent => component !== undefined);
  return {
    stepName: props.name,
    line: lineOf(node),
    hidden: hiddenReason !== undefined,
    ...(hiddenReason === undefined ? {} : { hiddenReason }),
    components,
  };
};

const parseHiddenBlock = (node: MdxNode, sourcePath: string): GuideHiddenBlock => {
  assertAlpha2Component("Hidden", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeHiddenPropsEither(rawProps), sourcePath, "Hidden", rawProps);
  return {
    kind: "hidden",
    reason: props.reason,
    line: lineOf(node),
    steps: elementChildren(node)
      .filter((child) => child.name === "Step")
      .map((child) => parseStep(child, sourcePath, props.reason)),
  };
};

const parseSkipBlock = (node: MdxNode, sourcePath: string): GuideSkipBlock => {
  assertAlpha2Component("Skip", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeSkipPropsEither(rawProps), sourcePath, "Skip", rawProps);
  return {
    kind: "skip",
    reason: props.reason,
    ...(props.until === undefined ? {} : { until: props.until }),
    line: lineOf(node),
    steps: elementChildren(node)
      .filter((child) => child.name === "Step")
      .map((child) => parseStep(child, sourcePath)),
  };
};

const parseTab = (node: MdxNode, sourcePath: string): GuideTabNode => {
  assertAlpha2Component("Tab", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeTabPropsEither(rawProps), sourcePath, "Tab", rawProps);
  return {
    name: props.name,
    line: lineOf(node),
    steps: elementChildren(node)
      .filter((child) => child.name === "Step")
      .map((child) => parseStep(child, sourcePath)),
  };
};

const parseTabsBlock = (node: MdxNode, sourcePath: string): GuideTabsBlock => {
  assertAlpha2Component("Tabs", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeTabsPropsEither(rawProps), sourcePath, "Tabs", rawProps);
  return {
    kind: "tabs",
    axis: props.axis ?? DEFAULT_AXIS,
    line: lineOf(node),
    tabs: elementChildren(node)
      .filter((child) => child.name === "Tab")
      .map((child) => parseTab(child, sourcePath)),
  };
};

const parseScenarioBody = (node: MdxNode, sourcePath: string): ReadonlyArray<GuideScenarioBodyItem> =>
  elementChildren(node)
    .filter(
      (child) =>
        child.name === "Step" || child.name === "Tabs" || child.name === "Hidden" || child.name === "Skip",
    )
    .map((child) => {
      if (child.name === "Tabs") return parseTabsBlock(child, sourcePath);
      if (child.name === "Hidden") return parseHiddenBlock(child, sourcePath);
      if (child.name === "Skip") return parseSkipBlock(child, sourcePath);
      return { kind: "step" as const, step: parseStep(child, sourcePath) };
    });

const unconditionalSteps = (body: ReadonlyArray<GuideScenarioBodyItem>): ReadonlyArray<GuideStepNode> =>
  body.flatMap((item) => {
    if (item.kind === "step") return [item.step];
    if (item.kind === "hidden") return item.steps;
    return [];
  });

const parseScenario = (node: MdxNode, sourcePath: string): GuideScenarioNode => {
  assertAlpha2Component("Scenario", sourcePath);
  const props = propsOf(node);
  if (props.render === false && (typeof props.reason !== "string" || props.reason.length < 8)) {
    throw new GuideHiddenScenarioReasonError({
      message: `<Scenario render={false}> at ${sourcePath} requires a reason of at least 8 characters.`,
      commandId: "guide.scenario.hidden-reason",
      sourcePath,
      scenarioId: typeof props.id === "string" ? props.id : "<unknown>",
      rejectedValue: props.reason,
      remediation: "Add a colocated `<Scenario render={false}>` reason of at least 8 characters.",
    });
  }
  const scenario = decodeOrThrow(decodeScenarioPropsEither(props), sourcePath, "Scenario", props);
  const body = parseScenarioBody(node, sourcePath);
  return {
    id: scenario.id,
    render: scenario.render,
    ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
    ...(scenario.layer === undefined ? {} : { layer: scenario.layer }),
    ...(scenario.tags === undefined ? {} : { tags: scenario.tags }),
    line: lineOf(node),
    steps: unconditionalSteps(body),
    body,
  };
};

export const parseGuideScenarioAst = (sourcePath: string, content: string): GuideScenarioAst => {
  const root = processor.parse(content) as MdxNode;
  const frontmatter = decodeFrontmatter(sourcePath, parseFrontmatter(sourcePath, firstYaml(root)));
  const guide = elementChildren(root).find((child) => child.name === "Guide");
  if (guide === undefined) {
    return { sourcePath, frontmatter, guideLine: 1, scenarios: [] };
  }
  assertAlpha2Component("Guide", sourcePath);
  for (const child of elementChildren(guide)) {
    if (child.name !== "Scenario" && child.name !== undefined && child.name !== null) {
      assertAlpha2Component(child.name, sourcePath);
    }
  }
  return {
    sourcePath,
    frontmatter,
    guideLine: lineOf(guide),
    scenarios: elementChildren(guide)
      .filter((child) => child.name === "Scenario")
      .map((child) => parseScenario(child, sourcePath))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const walkMdx = async (root: string, dir: string): Promise<ReadonlyArray<string>> => {
  const absolute = resolve(root, dir);
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walkMdx(root, child);
      return entry.isFile() && entry.name.endsWith(".mdx") ? [child] : [];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
};

const discoverRecipeReadmes = async (root: string): Promise<ReadonlyArray<string>> => {
  const recipesRoot = resolve(root, "recipes");
  let entries: Dirent[];
  try {
    entries = await readdir(recipesRoot, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `recipes/${entry.name}/README.mdx`)
    .sort((left, right) => left.localeCompare(right));
  const existing = await Promise.all(
    candidates.map(async (path) => ((await Bun.file(resolve(root, path)).exists()) ? path : undefined)),
  );
  return existing
    .filter((path): path is string => path !== undefined)
    .sort((left, right) => left.localeCompare(right));
};

export const discoverGuideMdxFiles = async (root = REPO_ROOT): Promise<ReadonlyArray<string>> => {
  const [guides, recipes] = await Promise.all([walkMdx(root, GUIDE_ROOT), discoverRecipeReadmes(root)]);
  return [...guides, ...recipes].sort((left, right) => left.localeCompare(right));
};

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
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
};

type PublicTranscriptFrameInput = {
  kind: "step" | "run" | "verify" | "inspect" | "cleanup" | "inline" | "tab";
  sourceFile: string;
  sourceLine: number;
  displayText?: string;
  commandDisplay?: string;
  resultSummary?: string;
};

const variantStringOf = (variant: GuideVariant | undefined): string =>
  variant === undefined ? "" : variant.pairs.map((pair) => `${pair.axis}=${pair.value}`).join(" ");

const runResultSummary = (props: RunProps): string => {
  if (isLibraryRunProps(props)) return "library code executed";
  if ("command" in props) return `expected exit ${props.expectExit ?? 0}`;
  return "shell command";
};

const verifyResultSummary = (props: VerifyProps, variables: ReadonlyMap<string, VariableProps>): string => {
  if (props.event !== undefined) return `event ${quote(props.event)} observed`;
  if (props.file !== undefined)
    return `file ${quote(interpolate(props.file, variables))} matches expectation`;
  if (props.command !== undefined) {
    return `command ${quote(interpolate(props.command, variables))} succeeds`;
  }
  return `error tag ${quote(props.errorTag ?? "")} observed`;
};

const inspectDisplay = (props: InspectProps, variables: ReadonlyMap<string, VariableProps>): string => {
  if (props.file !== undefined) return `inspect file ${quote(interpolate(props.file, variables))}`;
  if (props.json !== undefined) return `inspect json ${quote(interpolate(props.json, variables))}`;
  if (props.events === true) return "inspect events";
  return "inspect output";
};

const publicFrameForComponent = (
  component: GuideStepComponent,
  sourceFile: string,
  variables: ReadonlyMap<string, VariableProps>,
): PublicTranscriptFrameInput | undefined => {
  const base = { sourceFile, sourceLine: component.line } as const;
  switch (component.kind) {
    case "Variable":
    case "UseFixture":
      return undefined;
    case "Run":
      return {
        ...base,
        kind: "run",
        commandDisplay: isLibraryRunProps(component.props)
          ? component.props.displayCode
          : "command" in component.props
            ? interpolate(component.props.command, variables)
            : component.props.shell,
        resultSummary: runResultSummary(component.props),
      };
    case "Verify": {
      const command = component.props.command;
      const commandDisplay = command === undefined ? undefined : interpolate(command, variables);
      return {
        ...base,
        kind: "verify",
        ...(commandDisplay === undefined ? {} : { commandDisplay }),
        resultSummary: verifyResultSummary(component.props, variables),
      };
    }
    case "Inspect":
      return { ...base, kind: "inspect", displayText: inspectDisplay(component.props, variables) };
    case "Inline":
      return {
        ...base,
        kind: "inline",
        displayText: `inline ${component.props.lang}`,
        commandDisplay: component.props.code,
      };
    case "Cleanup":
      return { ...base, kind: "cleanup", displayText: "cleanup" };
  }
};

const tabSourceLine = (
  scenario: GuideScenarioNode,
  variant: GuideVariant,
  pair: GuideVariantPair,
): number => {
  for (const item of scenario.body) {
    if (item.kind !== "tabs") continue;
    if (effectiveAxisOf(item, variant) !== pair.axis) continue;
    const tab = item.tabs.find((candidate) => candidate.name === pair.value);
    if (tab !== undefined) return tab.line;
  }
  return scenario.line;
};

export const buildPublicTranscript = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
): PublicTranscript | undefined => {
  if (scenario.render === false) return undefined;
  if (variant?.skip !== undefined) return undefined;
  const resolved = resolveVariantSteps(scenario, variant);
  const runMode = assertScenarioRunMode(guide, scenario, resolved.steps);
  const visibleSteps = resolved.steps.filter((step) => !step.hidden);
  const variables = collectVariables(visibleSteps);
  const frames: PublicTranscriptFrameInput[] = [];
  if (variant !== undefined) {
    for (const pair of variant.pairs) {
      frames.push({
        kind: "tab",
        sourceFile: guide.sourcePath,
        sourceLine: tabSourceLine(scenario, variant, pair),
        displayText: `${pair.axis}=${pair.value}`,
      });
    }
  }
  for (const step of visibleSteps) {
    frames.push({
      kind: "step",
      sourceFile: guide.sourcePath,
      sourceLine: step.line,
      displayText: step.stepName,
    });
    for (const component of step.components) {
      const frame = publicFrameForComponent(component, guide.sourcePath, variables);
      if (frame !== undefined) frames.push(frame);
    }
  }
  return {
    guideId: guide.frontmatter.id,
    scenarioId: scenario.id,
    variant: variantStringOf(variant),
    runtime: effectiveScenarioLayer(guide, scenario) === "e2e" ? "e2e" : runMode,
    render: true,
    frames,
  };
};

export const publicTranscriptVariantSuffix = (variant: GuideVariant | undefined): string =>
  variant === undefined ? "" : `.${variant.pairs.map((pair) => pair.value).join(".")}`;

export const publicTranscriptSuffixFromVariantString = (variant: string): string =>
  variant === ""
    ? ""
    : `.${variant
        .split(" ")
        .map((pair) => pair.split("=")[1] ?? "")
        .join(".")}`;

export const publicTranscriptRelativePath = (
  guideId: string,
  scenarioId: string,
  variant: GuideVariant | undefined,
  outputRoot = PUBLIC_TRANSCRIPT_ROOT,
): string => `${outputRoot}/${guideId}/${scenarioId}${publicTranscriptVariantSuffix(variant)}.json`;

export const emitPublicTranscripts = async (
  asts: ReadonlyArray<GuideScenarioAst>,
  root = REPO_ROOT,
  outputRoot = PUBLIC_TRANSCRIPT_ROOT,
  options: EmitGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> => {
  await rm(resolve(root, outputRoot, options.clearGuideId ?? ""), { force: true, recursive: true });
  const written: string[] = [];
  for (const guide of asts) {
    const guideId = guide.frontmatter.id;
    const variants = variantsOf(guide);
    for (const scenario of [...guide.scenarios].sort((left, right) => left.id.localeCompare(right.id))) {
      for (const variant of variants) {
        const transcript = buildPublicTranscript(guide, scenario, variant);
        if (transcript === undefined) continue;
        const relativePath = publicTranscriptRelativePath(guideId, scenario.id, variant, outputRoot);
        const absolutePath = resolve(root, relativePath);
        await mkdir(dirname(absolutePath), { recursive: true });
        const encoded = Schema.encodeSync(PublicTranscript)(transcript);
        await Bun.write(absolutePath, `${JSON.stringify(encoded, null, 2)}\n`);
        written.push(relativePath);
      }
    }
  }
  return written.sort((left, right) => left.localeCompare(right));
};

export const emitGuideScenarioTests = async (
  asts: ReadonlyArray<GuideScenarioAst>,
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
  options: EmitGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> => {
  await rm(resolve(root, outputRoot, options.clearGuideId ?? ""), { force: true, recursive: true });
  const written: string[] = [];
  const hostPlatform = resolveHostGuidePlatform();
  for (const guide of asts) {
    const guideId = guide.frontmatter.id;
    const variants = variantsOf(guide);
    for (const scenario of [...guide.scenarios].sort((left, right) => left.id.localeCompare(right.id))) {
      for (const variant of variants) {
        const suffix = variant === undefined ? "" : `.${variant.pairs.map((pair) => pair.value).join(".")}`;
        const relativePath = `${outputRoot}/${guideId}/${scenario.id}${suffix}.test.ts`;
        const absolutePath = resolve(root, relativePath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await Bun.write(absolutePath, renderScenarioTest(guide, scenario, variant, hostPlatform));
        written.push(relativePath);
      }
    }
  }
  return written.sort((left, right) => left.localeCompare(right));
};

export const buildGuideScenarioTests = async (
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
  options: BuildGuideScenarioOptions = {},
): Promise<ReadonlyArray<string>> =>
  emitGuideScenarioTests(await buildGuideScenarioAst(root, options), root, outputRoot, {
    ...(options.onlyGuide === undefined ? {} : { clearGuideId: options.onlyGuide }),
  });

const parseBuildGuideScenarioArgs = (args: ReadonlyArray<string>): BuildGuideScenarioOptions => {
  const options: { onlyGuide?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--only") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--only requires a guide id");
      options.onlyGuide = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--only=")) {
      options.onlyGuide = arg.slice("--only=".length);
      continue;
    }
    throw new Error(`Unknown build-guide-scenarios flag: ${arg}`);
  }
  return options;
};

const main = async (): Promise<void> => {
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
};

if (import.meta.main) await main();
