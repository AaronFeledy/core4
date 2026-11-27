import { scanLandoFlags } from "../../cli/lando-flags.ts";
import { CAPTURE_ARG } from "./capture-token.ts";
import { semanticError } from "./diagnostic.ts";
import type { GuideScenarioNode, GuideStepNode, GuideVariant, ParsedGuide } from "./model.ts";
import { variantDetail } from "./variants.ts";

const requestsJsonEnvelope = (argv: readonly string[]): boolean => {
  let format: string | undefined;
  let earlyOutput = false;
  scanLandoFlags(argv, {
    "--format": ({ value }) => {
      format = value;
    },
    "--json": () => {
      earlyOutput = true;
    },
    "--jq": () => {
      earlyOutput = true;
    },
    "--help": () => {
      earlyOutput = true;
    },
    "-h": () => {
      earlyOutput = true;
    },
  });
  return format === "json" && !earlyOutput;
};

export const validateCaptures = (
  guide: ParsedGuide,
  scenario: GuideScenarioNode,
  cell: { readonly variant: GuideVariant | undefined; readonly steps: readonly GuideStepNode[] },
): void => {
  const regular: GuideStepNode[] = [];
  const cleanup: GuideStepNode[] = [];
  for (const step of cell.steps)
    (step.components.some((component) => component.kind === "Cleanup") ? cleanup : regular).push(step);
  const commands = [...regular, ...cleanup.reverse()].flatMap((step) =>
    step.components.flatMap((component) =>
      (component.kind === "Run" || component.kind === "Verify") && component.argv !== undefined
        ? [
            {
              component,
              argv: component.argv,
              capture:
                component.kind === "Run" && "command" in component.props
                  ? component.props.capture
                  : undefined,
            },
          ]
        : [],
    ),
  );
  const declarations = new Set(commands.flatMap(({ capture }) => (capture ? [capture.name] : [])));
  const available = new Set<string>();
  for (const { component, argv, capture } of commands) {
    const report = (code: string, prop: "capture" | "command", name: string): never =>
      semanticError(guide, scenario, {
        ...variantDetail(cell.variant),
        code: `guide.capture.${code}`,
        line: component.line,
        component: component.kind,
        prop,
        name,
      });
    if (capture !== undefined) {
      if (scenario.render) report("hidden-only", "capture", capture.name);
      if (!requestsJsonEnvelope(argv)) report("json-required", "capture", capture.name);
      if (available.has(capture.name)) report("duplicate", "capture", capture.name);
    }
    for (const [index, arg] of argv.entries()) {
      if (!arg.includes("{{capture:")) continue;
      const name = CAPTURE_ARG.exec(arg)?.[1];
      if (name === undefined || index <= (argv[0] === "lando" || argv[0] === "lando4" ? 1 : 0))
        report("argument", "command", arg);
      else if (!available.has(name))
        report(declarations.has(name) ? "before-declaration" : "unknown", "command", name);
    }
    if (capture !== undefined) available.add(capture.name);
  }
};
