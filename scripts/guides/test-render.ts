import type { GuidePlatform } from "../../sdk/src/docs/guide-frontmatter.ts";
import type { GuideScenarioAst, GuideScenarioNode, GuideVariant } from "./model.ts";
import { resolveScenario } from "./resolve.ts";
import {
  renderCleanupFinalizers,
  renderStepComponent,
  renderVariableSetup,
  sourceComment,
} from "./test-components.ts";

export const renderScenarioTest = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  requestedVariant: GuideVariant | undefined,
  hostPlatform: GuidePlatform,
): string => {
  const resolved = resolveScenario(guide, scenario, requestedVariant);
  const variant = resolved.variant;
  const scenarioLayer = scenario.layer ?? guide.frontmatter.defaultLayer ?? "scenario";
  const usesLibraryRuntime = resolved.runMode === "library";
  const usesE2eRuntime = scenarioLayer === "e2e";
  const variableSetup = renderVariableSetup(resolved.variables);
  const cleanupFinalizers = renderCleanupFinalizers(resolved.steps, guide.sourcePath);
  const steps = resolved.steps
    .map((step) => {
      const components = step.components
        .map((component) => renderStepComponent(component, guide.sourcePath))
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
  const effectiveTags = [
    ...new Set([...(variant?.tags ?? guide.frontmatter.tags ?? []), ...(scenario.tags ?? [])]),
  ];
  const effectivePlatforms = variant?.platforms ?? guide.frontmatter.platforms;
  const hostPlatforms = hostPlatform === "wsl" ? ["wsl", "linux"] : [hostPlatform];
  const platformSkip =
    effectivePlatforms !== undefined &&
    effectivePlatforms.length > 0 &&
    !hostPlatforms.some((p) => effectivePlatforms.some((allowed) => allowed === p))
      ? `skipped on ${hostPlatform}: requires platform [${effectivePlatforms.join(",")}]`
      : undefined;
  const annotationLines = [
    ...(effectiveTags.length === 0 ? [] : [`// @tags: ${effectiveTags.join(",")}`]),
    ...(usesE2eRuntime ? ["// @layer: e2e"] : []),
    ...(effectivePlatforms === undefined ? [] : [`// @platforms: ${effectivePlatforms.join(",")}`]),
    ...(variant?.skip === undefined ? [] : [`// @variant-skip: ${variant.skip.reason}`]),
  ];
  const variantAnnotations = annotationLines.length === 0 ? "" : `\n${annotationLines.join("\n")}`;
  const skips =
    variant?.skip === undefined
      ? resolved.skips
          .map((skip) => `// @skip: ${skip.reason}\ntest.skip(${JSON.stringify(skip.stepName)}, () => {});`)
          .join("\n")
      : "";
  const forcedSkip = variant?.skip !== undefined || platformSkip !== undefined;
  const label =
    variant === undefined || variant.pairs.length === 0
      ? ""
      : ` (${[...variant.pairs]
          .sort((a, b) => a.axis.localeCompare(b.axis))
          .map((pair) => `${pair.axis}=${pair.value}`)
          .join(" ")})`;
  const taggedTestName = `${effectiveTags.length === 0 ? "" : `${effectiveTags.join(" ")} `}${guide.frontmatter.id}:${scenario.id}${label}${usesE2eRuntime ? " [e2e]" : ""}`;
  const runnableTestName = JSON.stringify(
    platformSkip === undefined ? taggedTestName : `${taggedTestName} (${platformSkip})`,
  );
  const skippedE2eTestName = JSON.stringify(
    `${taggedTestName} (skipped: set LANDO_GUIDE_E2E=1, LANDO_SCENARIO_E2E_BINARY, and LANDO_TEST_PODMAN_SOCKET to a live provider socket)`,
  );
  const testNameExpression =
    usesE2eRuntime && !forcedSkip
      ? `(e2eGateEnabled ? ${runnableTestName} : ${skippedE2eTestName})`
      : runnableTestName;
  const testFnExpression = forcedSkip
    ? "test.skip"
    : usesE2eRuntime
      ? "(e2eGateEnabled ? test : test.skip)"
      : "test";
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
import { Cause, Effect, Exit, Result } from "effect";
${usesLibraryRuntime ? 'import * as LandoCore from "@lando/core";\nimport * as LandoTesting from "@lando/core/testing";' : usesE2eRuntime ? 'import { ScenarioContextFactory, hasLiveProviderSocket } from "@lando/core/testing";' : 'import { withScenarioContext } from "@lando/core/testing";'}

${usesE2eRuntime ? 'const e2eGateEnabled = process.env.LANDO_GUIDE_E2E === "1";' : ""}

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
${
  usesE2eRuntime
    ? `  if (!hasLiveProviderSocket()) throw new Error("LANDO_GUIDE_E2E=1 requires an answering LANDO_TEST_PODMAN_SOCKET; configure the job-owned runtime before running e2e guides.");
  if (process.env.LANDO_SCENARIO_E2E_BINARY === undefined) throw new Error("LANDO_GUIDE_E2E=1 requires LANDO_SCENARIO_E2E_BINARY.");
`
    : ""
}  const exit = await Effect.runPromiseExit(
    ${contextRunner}({ guideId: ${JSON.stringify(guide.frontmatter.id)}, scenarioId: ${JSON.stringify(scenario.id)}, render: ${scenario.render} }, (context) =>
      Effect.gen(function* () {
        let lastRun: unknown;
        let lastFailure: unknown;
${variableSetup === "" ? "" : `${variableSetup}\n`}${cleanupFinalizers === "" ? "" : `${cleanupFinalizers}\n`}${steps}
      }),
    ),
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause), { cause: exit.cause });
}, ${guide.frontmatter.timeout});
${skips === "" ? "" : `\n${skips}\n`}`;
};
