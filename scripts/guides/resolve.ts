import type { VariableProps } from "../../sdk/src/docs/components/index.ts";
import { semanticError } from "./diagnostic.ts";
import type {
  GuideScenarioAst,
  GuideScenarioNode,
  GuideStepComponent,
  GuideStepNode,
  GuideVariant,
  ParsedGuide,
  ResolvedScenario,
} from "./model.ts";
import { selectScenario, variantDetail, variantsOf } from "./variants.ts";

// Simple identifiers allow surrounding whitespace; dotted expressions and opaque props remain literal.
const TOKEN = /\{\{\s*([A-Za-z_$][\w$-]*)\s*\}\}/g;
const NAME = /^[A-Za-z_$][\w$-]*$/;
type Binding = { readonly props: VariableProps; readonly line: number; readonly public: boolean };

const resolveCell = (
  guide: ParsedGuide,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
): ResolvedScenario => {
  const selected = selectScenario(guide, scenario, variant);
  const bindings = new Map<string, Binding>();
  const consumed = new Set<string>();
  const names = new Map<string, number>();
  let cliLine: number | undefined;
  let libraryLine: number | undefined;
  for (const step of selected.steps) {
    const previousStep = names.get(step.stepName);
    if (previousStep !== undefined)
      semanticError(guide, scenario, {
        ...variantDetail(variant),
        code: "guide.step.duplicate-name",
        line: step.line,
        component: "Step",
        prop: "name",
        name: step.stepName,
        relatedDeclarationLine: previousStep,
      });
    names.set(step.stepName, step.line);
    for (const component of step.components) {
      switch (component.kind) {
        case "Variable": {
          const name = component.props.name;
          const previous = bindings.get(name);
          if (!NAME.test(name))
            semanticError(guide, scenario, {
              ...variantDetail(variant),
              code: "guide.variable.invalid-name",
              line: component.line,
              component: "Variable",
              prop: "name",
              name,
            });
          if (previous !== undefined)
            semanticError(guide, scenario, {
              ...variantDetail(variant),
              code: "guide.variable.duplicate",
              line: component.line,
              component: "Variable",
              prop: "name",
              name,
              relatedDeclarationLine: previous.line,
            });
          bindings.set(name, {
            props: component.props,
            line: component.line,
            public: scenario.render && !step.hidden,
          });
          break;
        }
        case "Run":
          if ("runtime" in component.props) libraryLine = component.line;
          else cliLine = component.line;
          break;
        case "Cleanup":
        case "Verify":
        case "Inspect":
        case "Inline":
        case "UseFixture":
          break;
      }
    }
  }
  if (cliLine !== undefined && libraryLine !== undefined)
    semanticError(guide, scenario, {
      ...variantDetail(variant),
      code: "guide.runtime.mixed",
      line: libraryLine,
      component: "Run",
      prop: "runtime",
      name: "library",
      relatedDeclarationLine: cliLine,
    });
  if (libraryLine !== undefined && (scenario.layer ?? guide.frontmatter.defaultLayer) === "e2e")
    semanticError(guide, scenario, {
      ...variantDetail(variant),
      code: "guide.runtime.e2e-library",
      line: libraryLine,
      component: "Run",
      prop: "runtime",
      name: "library",
    });

  const interpolate = (
    text: string,
    site: { readonly step: GuideStepNode; readonly component: GuideStepComponent; readonly prop: string },
    display: boolean,
  ): string =>
    text.replace(TOKEN, (_token, name: string) => {
      const binding = bindings.get(name);
      const detail = {
        ...variantDetail(variant),
        line: site.component.line,
        component: site.component.kind,
        prop: site.prop,
        name,
      };
      if (binding === undefined)
        return semanticError(guide, scenario, { ...detail, code: "guide.variable.missing" });
      if (scenario.render && !site.step.hidden && !binding.public)
        return semanticError(guide, scenario, {
          ...detail,
          code: "guide.variable.hidden-reference",
          relatedDeclarationLine: binding.line,
        });
      consumed.add(name);
      return display ? (binding.props.display ?? binding.props.value) : binding.props.value;
    });
  const projectStep = (step: GuideStepNode, display: boolean): GuideStepNode => ({
    ...step,
    components: step.components.map((component): GuideStepComponent => {
      const replace = (text: string, prop: string) => interpolate(text, { step, component, prop }, display);
      switch (component.kind) {
        case "Run":
          return "command" in component.props
            ? {
                ...component,
                props: { ...component.props, command: replace(component.props.command, "command") },
              }
            : component;
        case "Verify":
          return {
            ...component,
            props: {
              ...component.props,
              ...(component.props.command === undefined
                ? {}
                : { command: replace(component.props.command, "command") }),
              ...(component.props.file === undefined ? {} : { file: replace(component.props.file, "file") }),
            },
          };
        case "Inspect":
          return {
            ...component,
            props: {
              ...component.props,
              ...(component.props.file === undefined ? {} : { file: replace(component.props.file, "file") }),
              ...(component.props.json === undefined ? {} : { json: replace(component.props.json, "json") }),
            },
          };
        case "Variable":
        case "Cleanup":
        case "Inline":
        case "UseFixture":
          return component;
      }
    }),
  });
  const steps = selected.steps.map((step) => projectStep(step, false));
  const publicSteps = scenario.render
    ? selected.steps.filter((step) => !step.hidden).map((step) => projectStep(step, true))
    : [];
  for (const [name, binding] of bindings)
    if (!consumed.has(name))
      semanticError(guide, scenario, {
        ...variantDetail(variant),
        code: "guide.variable.unused",
        line: binding.line,
        component: "Variable",
        prop: "name",
        name,
      });
  return {
    variant,
    steps,
    publicSteps,
    skips: selected.skips,
    tabs: selected.tabs,
    variables: new Map([...bindings].map(([name, binding]) => [name, binding.props])),
    runMode: libraryLine === undefined ? "cli" : "library",
  };
};

export const resolveGuide = (guide: ParsedGuide): GuideScenarioAst => {
  const ids = new Map<string, number>();
  const cells: Array<{ readonly scenarioId: string; readonly resolved: ResolvedScenario }> = [];
  for (const scenario of guide.scenarios) {
    const previous = ids.get(scenario.id);
    if (previous !== undefined)
      semanticError(guide, scenario, {
        code: "guide.scenario.duplicate-id",
        line: scenario.line,
        component: "Scenario",
        prop: "id",
        name: scenario.id,
        relatedDeclarationLine: previous,
      });
    ids.set(scenario.id, scenario.line);
    for (const variant of variantsOf(guide))
      cells.push({ scenarioId: scenario.id, resolved: resolveCell(guide, scenario, variant) });
  }
  return { ...guide, cells };
};

export const resolveScenario = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  variant: GuideVariant | undefined,
): ResolvedScenario => {
  const key = JSON.stringify(variant?.pairs ?? []);
  const cell = guide.cells.find(
    (candidate) =>
      candidate.scenarioId === scenario.id && JSON.stringify(candidate.resolved.variant?.pairs ?? []) === key,
  );
  if (cell === undefined)
    return semanticError(guide, scenario, {
      ...variantDetail(variant),
      code: "guide.variant.undeclared",
      line: scenario.line,
      component: "Scenario",
      prop: "variant",
      name: scenario.id,
    });
  return cell.resolved;
};
