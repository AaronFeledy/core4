import { redactPublicTranscriptText } from "../../core/src/docs/render/index.ts";
import { encodeVariantPair, encodeVariantString, variantFileSuffix } from "../../core/src/docs/variant.ts";
import type { PublicTranscript } from "../../sdk/src/docs/components/index.ts";
import type { GuideScenarioAst, GuideScenarioNode, GuideStepComponent, GuideVariant } from "./model.ts";
import { resolveScenario } from "./resolve.ts";

export const PUBLIC_TRANSCRIPT_REDACTION_ENV = { home: "", tmp: "", user: "", host: "", extraRoots: [] };
export const variantStringOf = (variant: GuideVariant | undefined): string =>
  variant === undefined
    ? ""
    : encodeVariantString(variant.pairs.map((pair) => encodeVariantPair(pair.axis, pair.value)));
export const publicTranscriptVariantSuffix = (variant: GuideVariant | undefined): string =>
  variantFileSuffix(variantStringOf(variant));
export const publicTranscriptSuffixFromVariantString = (variant: string): string =>
  variantFileSuffix(variant);

type Frame = PublicTranscript["frames"][number];
const frameForComponent = (component: GuideStepComponent, sourceFile: string): Frame | undefined => {
  const base = { sourceFile, sourceLine: component.line };
  switch (component.kind) {
    case "Variable":
    case "UseFixture":
      return undefined;
    case "Run": {
      const props = component.props;
      return {
        ...base,
        kind: "run",
        commandDisplay:
          "runtime" in props ? props.displayCode : "command" in props ? props.command : props.shell,
        resultSummary:
          "runtime" in props
            ? "library code executed"
            : "command" in props
              ? `expected exit ${props.expectExit ?? 0}`
              : "shell command",
      };
    }
    case "Verify": {
      const props = component.props;
      const summary =
        props.event !== undefined
          ? `event ${JSON.stringify(props.event)} observed`
          : props.file !== undefined
            ? `file ${JSON.stringify(props.file)} matches expectation`
            : props.command !== undefined
              ? props.expectExit === undefined || props.expectExit === 0
                ? `command ${JSON.stringify(props.command)} succeeds`
                : `expected exit ${props.expectExit}`
              : `error tag ${JSON.stringify(props.errorTag ?? "")} observed`;
      return {
        ...base,
        kind: "verify",
        ...(props.command === undefined ? {} : { commandDisplay: props.command }),
        resultSummary: summary,
      };
    }
    case "Inspect": {
      const props = component.props;
      const displayText =
        props.file !== undefined
          ? `inspect file ${JSON.stringify(props.file)}`
          : props.json !== undefined
            ? `inspect json ${JSON.stringify(props.json)}`
            : props.events === true
              ? "inspect events"
              : "inspect output";
      return { ...base, kind: "inspect", displayText };
    }
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
export const buildPublicTranscript = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  requestedVariant: GuideVariant | undefined,
): PublicTranscript | undefined => {
  const resolved = resolveScenario(guide, scenario, requestedVariant);
  const variant = resolved.variant;
  if (!scenario.render || variant?.skip !== undefined) return undefined;
  const frames: Frame[] = [];
  for (const pair of variant?.pairs ?? [])
    frames.push({
      kind: "tab",
      sourceFile: guide.sourcePath,
      sourceLine:
        resolved.tabs.find((tab) => tab.axis === pair.axis && tab.value === pair.value)?.line ??
        scenario.line,
      displayText: `${pair.axis}=${pair.value}`,
    });
  for (const step of resolved.publicSteps) {
    frames.push({
      kind: "step",
      sourceFile: guide.sourcePath,
      sourceLine: step.line,
      displayText: step.stepName,
    });
    for (const component of step.components) {
      const frame = frameForComponent(component, guide.sourcePath);
      if (frame !== undefined) frames.push(frame);
    }
  }
  const redact = (text: string) => redactPublicTranscriptText(text, PUBLIC_TRANSCRIPT_REDACTION_ENV);
  return {
    guideId: guide.frontmatter.id,
    scenarioId: scenario.id,
    variant: variantStringOf(variant),
    runtime: (scenario.layer ?? guide.frontmatter.defaultLayer) === "e2e" ? "e2e" : resolved.runMode,
    render: true,
    frames: frames.map((frame) => ({
      ...frame,
      ...(frame.displayText === undefined ? {} : { displayText: redact(frame.displayText) }),
      ...(frame.commandDisplay === undefined ? {} : { commandDisplay: redact(frame.commandDisplay) }),
      ...(frame.resultSummary === undefined ? {} : { resultSummary: redact(frame.resultSummary) }),
    })),
  };
};
