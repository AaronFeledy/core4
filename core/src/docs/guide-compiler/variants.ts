import { semanticError } from "./diagnostic.ts";
import type {
  GuideScenarioNode,
  GuideStepNode,
  GuideVariant,
  GuideVariantPair,
  ParsedGuide,
} from "./model.ts";

export const variantsOf = (guide: ParsedGuide): ReadonlyArray<GuideVariant | undefined> => {
  const fm = guide.frontmatter;
  const entries =
    fm.tabs !== undefined && fm.tabs.length > 0
      ? [["default", fm.tabs] as const]
      : Object.entries(fm.axes ?? {});
  if (entries.length === 0 && fm.skip === undefined) return [undefined];
  let combinations: ReadonlyArray<ReadonlyArray<GuideVariantPair>> = [[]];
  for (const [axis, values] of entries)
    combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, { axis, value }]));
  return combinations.map((pairs) => {
    const override = fm.variants?.[pairs.map((pair) => pair.value).join(".")];
    const skip = override?.skip ?? fm.skip;
    const platforms = override?.platforms ?? fm.platforms;
    const tags = [...new Set([...(fm.tags ?? []), ...(override?.tags ?? [])])];
    return {
      pairs,
      ...(skip === undefined ? {} : { skip }),
      ...(platforms === undefined ? {} : { platforms }),
      ...(tags.length === 0 ? {} : { tags }),
    };
  });
};

export const selectScenario = (
  guide: ParsedGuide,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
) => {
  const steps: GuideStepNode[] = [];
  let omittedTab = false;
  const skipReasons: string[] = [];
  let emptySelectedTab = false;
  let explicitSkip = false;
  const skips: Array<{ readonly stepName: string; readonly reason: string }> = [];
  const tabs: Array<{
    readonly axis: string;
    readonly value: string;
    readonly line: number;
    readonly source?: import("./mdx.ts").MdxNode;
  }> = [];
  const axes =
    guide.frontmatter.tabs === undefined
      ? (guide.frontmatter.axes ?? {})
      : { default: guide.frontmatter.tabs };
  for (const item of scenario.body) {
    switch (item.kind) {
      case "step":
        steps.push(item.step);
        break;
      case "hidden":
        steps.push(...item.steps);
        break;
      case "skip":
        explicitSkip = true;
        skipReasons.push(item.reason);
        skips.push(...item.steps.map((step) => ({ stepName: step.stepName, reason: item.reason })));
        break;
      case "tabs": {
        const [singleAxis] = Object.keys(axes);
        const axis =
          item.axis === "default" && Object.keys(axes).length === 1 ? (singleAxis ?? "default") : item.axis;
        const values = axes[axis];
        if (values === undefined)
          return semanticError(guide, scenario, {
            ...variantDetail(variant),
            code: item.axis === "default" ? "guide.tabs.missing-axis" : "guide.tabs.unknown-axis",
            line: item.line,
            component: "Tabs",
            prop: "axis",
            name: axis,
          });
        const seen = new Map<string, number>();
        for (const tab of item.tabs) {
          const previous = seen.get(tab.name);
          if (previous !== undefined)
            semanticError(guide, scenario, {
              ...variantDetail(variant),
              code: "guide.tabs.duplicate-id",
              line: tab.line,
              component: "Tab",
              prop: "name",
              name: tab.name,
              relatedDeclarationLine: previous,
            });
          seen.set(tab.name, tab.line);
          if (!values.includes(tab.name))
            semanticError(guide, scenario, {
              ...variantDetail(variant),
              code: "guide.tabs.unknown-value",
              line: tab.line,
              component: "Tab",
              prop: "name",
              name: tab.name,
            });
        }
        const value = variant?.pairs.find((pair) => pair.axis === axis)?.value;
        const selected = item.tabs.find((tab) => tab.name === value);
        if (selected === undefined && item.tabs.length > 0) {
          omittedTab = true;
          skipReasons.push(`axis ${axis}=${value ?? ""} has no authored tab`);
        } else if (selected !== undefined && selected.steps.length === 0) emptySelectedTab = true;
        if (selected !== undefined) {
          steps.push(...selected.steps);
          tabs.push({
            axis,
            value: selected.name,
            line: selected.line,
            ...(selected.source === undefined ? {} : { source: selected.source }),
          });
        }
        const selectedNames = new Set(selected?.steps.map((step) => step.stepName));
        const union = new Set(item.tabs.flatMap((tab) => tab.steps.map((step) => step.stepName)));
        for (const stepName of union)
          if (!selectedNames.has(stepName))
            skips.push({
              stepName,
              reason: `axis ${axis}=${value ?? ""} tab does not include step ${stepName}`,
            });
        break;
      }
    }
  }
  return {
    steps,
    skips,
    tabs,
    skipReason: skipReasons.join("; "),
    skipOnly: omittedTab || (steps.length === 0 && !emptySelectedTab && explicitSkip),
  };
};

export const variantDetail = (variant: GuideVariant | undefined): { readonly variant?: GuideVariant } =>
  variant === undefined ? {} : { variant };
