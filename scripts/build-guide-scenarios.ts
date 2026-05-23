#!/usr/bin/env bun
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Either } from "effect";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseLandofile } from "../core/src/landofile/parser.ts";
import {
  type CleanupProps,
  type GuideFrontmatter,
  type RunProps,
  type UseFixtureProps,
  type VariableProps,
  type VerifyProps,
  assertAlpha2Component,
  decodeCleanupPropsEither,
  decodeGuideFrontmatterEither,
  decodeRunPropsEither,
  decodeScenarioPropsEither,
  decodeStepPropsEither,
  decodeUseFixturePropsEither,
  decodeVariablePropsEither,
  decodeVerifyPropsEither,
} from "../sdk/src/docs/components/index.ts";
import {
  GuideFrontmatterValidationError,
  GuideHiddenScenarioReasonError,
  NotImplementedError,
} from "../sdk/src/errors/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GUIDE_ROOT = "docs/guides";
const GENERATED_GUIDE_TEST_ROOT = "test/scenarios/generated/guides";

const isNotFound = (cause: unknown): boolean =>
  cause !== null && typeof cause === "object" && (cause as { code?: unknown }).code === "ENOENT";

export type GuideStepComponent =
  | { readonly kind: "Run"; readonly props: RunProps; readonly line: number }
  | { readonly kind: "Verify"; readonly props: VerifyProps; readonly line: number }
  | { readonly kind: "Cleanup"; readonly props: CleanupProps; readonly line: number }
  | { readonly kind: "Variable"; readonly props: VariableProps; readonly line: number }
  | { readonly kind: "UseFixture"; readonly props: UseFixtureProps; readonly line: number };

export interface GuideStepNode {
  readonly stepName: string;
  readonly line: number;
  readonly components: ReadonlyArray<GuideStepComponent>;
}

export interface GuideScenarioNode {
  readonly id: string;
  readonly render: boolean;
  readonly reason?: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}

export interface GuideScenarioAst {
  readonly sourcePath: string;
  readonly frontmatter: GuideFrontmatter;
  readonly guideLine: number;
  readonly scenarios: ReadonlyArray<GuideScenarioNode>;
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

const collectVariables = (scenario: GuideScenarioNode): ReadonlyMap<string, VariableProps> => {
  const variables = new Map<string, VariableProps>();
  for (const step of scenario.steps) {
    for (const component of step.components) {
      if (component.kind === "Variable") variables.set(component.props.name, component.props);
    }
  }
  return variables;
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

const renderCleanupFinalizers = (scenario: GuideScenarioNode, sourcePath: string): string =>
  scenario.steps
    .flatMap((step) => step.components.filter((component) => component.kind === "Cleanup"))
    .map(
      (component) =>
        `${sourceComment(sourcePath, component.line)}\n    yield* Effect.addFinalizer(() => Effect.void);`,
    )
    .join("\n");

const renderRun = (
  component: Extract<GuideStepComponent, { kind: "Run" }>,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  if (component.props.command !== undefined) {
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
  return `    yield* context.shell(${quote(component.props.shell ?? "")});`;
};

const renderVerify = (
  component: Extract<GuideStepComponent, { kind: "Verify" }>,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  const expected = component.props.expect === undefined ? undefined : renderMatcher(component.props.expect);
  if (component.props.event !== undefined) {
    const actual = `context.events.find((event) => event._tag === ${quote(component.props.event)})`;
    return expected === undefined
      ? `    expect(${actual}).toBeDefined();`
      : `    expect(matchesExpected(${actual}, ${expected})).toBe(true);`;
  }
  if (component.props.command !== undefined) {
    return [
      `    const verifyRun = yield* context.runCli(${quote(interpolate(component.props.command, variables))});`,
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
      ...(expected === undefined
        ? ["    expect(fileContent).toBeDefined();"]
        : [`    expect(matchesExpected(fileContent, ${expected})).toBe(true);`]),
    ].join("\n");
  }
  return [
    "    const failureForErrorTag = lastFailure ?? lastRun;",
    '    const failureText = typeof failureForErrorTag === "string" ? failureForErrorTag : JSON.stringify(failureForErrorTag);',
    `    expect(((failureForErrorTag as { _tag?: string })?._tag ?? failureText)).toContain(${quote(component.props.errorTag ?? "")});`,
    ...(expected === undefined ? [] : [`    expect(matchesExpected(failureText, ${expected})).toBe(true);`]),
  ].join("\n");
};

const renderStepComponent = (
  component: GuideStepComponent,
  sourcePath: string,
  variables: ReadonlyMap<string, VariableProps>,
): string => {
  if (component.kind === "Variable" || component.kind === "Cleanup") return "";
  const body = (() => {
    switch (component.kind) {
      case "Run":
        return renderRun(component, variables);
      case "Verify":
        return renderVerify(component, variables);
      case "UseFixture":
        return `    yield* context.fixtures.use(${quote(component.props.name)});`;
    }
  })();
  return `${sourceComment(sourcePath, component.line)}\n    {\n${body}\n    }`;
};

const renderScenarioTest = (guide: GuideScenarioAst, scenario: GuideScenarioNode): string => {
  const variables = collectVariables(scenario);
  const variableSetup = renderVariableSetup(variables);
  const cleanupFinalizers = renderCleanupFinalizers(scenario, guide.sourcePath);
  const steps = scenario.steps
    .map((step) => {
      const components = step.components
        .map((component) => renderStepComponent(component, guide.sourcePath, variables))
        .filter(Boolean)
        .join("\n");
      return `${sourceComment(guide.sourcePath, step.line)}\n    // @step: ${step.stepName}${components === "" ? "" : `\n${components}`}`;
    })
    .join("\n");

  return `// @generated
// @source: ${guide.sourcePath}:${scenario.line}
// @scenario: ${scenario.id}
${scenario.render === false ? "// @render: false\n" : ""}// @variant:

import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Either } from "effect";

import { withScenarioContext } from "@lando/core/testing";

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

test(${quote(`${guide.frontmatter.id}:${scenario.id}`)}, async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: ${quote(guide.frontmatter.id)}, scenarioId: ${quote(scenario.id)} }, (context) =>
      Effect.gen(function* () {
        let lastRun: unknown;
        let lastFailure: unknown;
${variableSetup === "" ? "" : `${variableSetup}\n`}${cleanupFinalizers === "" ? "" : `${cleanupFinalizers}\n`}${steps}
      }),
    ),
  );
});
`;
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
    default:
      return undefined;
  }
};

const parseStep = (node: MdxNode, sourcePath: string): GuideStepNode => {
  assertAlpha2Component("Step", sourcePath);
  const rawProps = propsOf(node);
  const props = decodeOrThrow(decodeStepPropsEither(rawProps), sourcePath, "Step", rawProps);
  const components = elementChildren(node)
    .map((child) => parseStepComponent(child, sourcePath))
    .filter((component): component is GuideStepComponent => component !== undefined);
  return { stepName: props.name, line: lineOf(node), components };
};

const parseScenario = (node: MdxNode, sourcePath: string): GuideScenarioNode => {
  assertAlpha2Component("Scenario", sourcePath);
  const props = propsOf(node);
  if (props.render === false && (typeof props.reason !== "string" || props.reason.length < 8)) {
    throw new GuideHiddenScenarioReasonError({
      message: `<Scenario render={false}> at ${sourcePath} requires a reason of at least 8 characters.`,
      commandId: "guide.scenario.hidden-reason",
      specSection: "§19.9",
      sourcePath,
      scenarioId: typeof props.id === "string" ? props.id : "<unknown>",
      rejectedValue: props.reason,
      remediation:
        "Add a colocated `<Scenario render={false}>` reason of at least 8 characters per §19.9 and PRD-A2-00's hidden-coverage rule.",
    });
  }
  const scenario = decodeOrThrow(decodeScenarioPropsEither(props), sourcePath, "Scenario", props);
  return {
    id: scenario.id,
    render: scenario.render,
    ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
    line: lineOf(node),
    steps: elementChildren(node)
      .filter((child) => child.name === "Step")
      .map((child) => parseStep(child, sourcePath)),
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
  let entries: Awaited<ReturnType<typeof readdir>>;
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
  let entries: Awaited<ReturnType<typeof readdir>>;
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

export const buildGuideScenarioAst = async (root = REPO_ROOT): Promise<ReadonlyArray<GuideScenarioAst>> => {
  const files = await discoverGuideMdxFiles(root);
  const asts = await Promise.all(
    files.map(async (sourcePath) =>
      parseGuideScenarioAst(sourcePath, await Bun.file(resolve(root, sourcePath)).text()),
    ),
  );
  return asts.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
};

export const emitGuideScenarioTests = async (
  asts: ReadonlyArray<GuideScenarioAst>,
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
): Promise<ReadonlyArray<string>> => {
  await rm(resolve(root, outputRoot), { force: true, recursive: true });
  const written: string[] = [];
  for (const guide of asts) {
    const guideId = guide.frontmatter.id;
    for (const scenario of [...guide.scenarios].sort((left, right) => left.id.localeCompare(right.id))) {
      const relativePath = `${outputRoot}/${guideId}/${scenario.id}.test.ts`;
      const absolutePath = resolve(root, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await Bun.write(absolutePath, renderScenarioTest(guide, scenario));
      written.push(relativePath);
    }
  }
  return written.sort((left, right) => left.localeCompare(right));
};

export const buildGuideScenarioTests = async (
  root = REPO_ROOT,
  outputRoot = GENERATED_GUIDE_TEST_ROOT,
): Promise<ReadonlyArray<string>> =>
  emitGuideScenarioTests(await buildGuideScenarioAst(root), root, outputRoot);

const main = async (): Promise<void> => {
  try {
    const written = await buildGuideScenarioTests(REPO_ROOT);
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) await main();
