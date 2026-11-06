import { GuideHiddenScenarioReasonError } from "@lando/core/errors";
import * as Components from "@lando/sdk/docs/components";
import type { Root } from "mdast";
import { GuideRootError, GuideStructureError } from "./diagnostic.ts";
import {
  type MdxNode,
  decodeFrontmatter,
  decodeOrThrow,
  elementChildren,
  firstYaml,
  lineOf,
  parseFrontmatter,
  processor,
  propsOf,
} from "./mdx.ts";
import type {
  GuideScenarioAst,
  GuideScenarioBodyItem,
  GuideScenarioNode,
  GuideStepComponent,
  GuideStepNode,
} from "./model.ts";
import { resolveGuide } from "./resolve.ts";

const structureChildren: Readonly<Record<string, readonly string[]>> = {
  root: ["Guide"],
  Guide: ["Scenario"],
  Scenario: ["Step", "Hidden", "Skip", "Tabs"],
  Hidden: ["Step"],
  Skip: ["Step"],
  Tab: ["Step"],
  Tabs: ["Tab"],
  Step: ["Run", "Verify", "Cleanup", "Variable", "UseFixture", "Inspect", "Inline"],
};

const parseComponent = (node: MdxNode, sourcePath: string): GuideStepComponent | undefined => {
  if (node.name == null) return undefined;
  Components.assertSupportedGuideComponent(node.name, sourcePath);
  const props = propsOf(node, sourcePath);
  const line = lineOf(node);
  switch (node.name) {
    case "Run":
      return {
        source: node,
        kind: "Run",
        props: decodeOrThrow(Components.decodeRunPropsEither(props), { sourcePath, node }),
        line,
      };
    case "Verify":
      return {
        source: node,
        kind: "Verify",
        props: decodeOrThrow(Components.decodeVerifyPropsEither(props), { sourcePath, node }),
        line,
      };
    case "Cleanup":
      return {
        source: node,
        kind: "Cleanup",
        props: decodeOrThrow(Components.decodeCleanupPropsEither(props), { sourcePath, node }),
        line,
      };
    case "Variable":
      return {
        source: node,
        kind: "Variable",
        props: decodeOrThrow(Components.decodeVariablePropsEither(props), { sourcePath, node }),
        line,
      };
    case "UseFixture":
      return {
        source: node,
        kind: "UseFixture",
        props: decodeOrThrow(Components.decodeUseFixturePropsEither(props), { sourcePath, node }),
        line,
      };
    case "Inspect":
      return {
        source: node,
        kind: "Inspect",
        props: decodeOrThrow(Components.decodeInspectPropsEither(props), { sourcePath, node }),
        line,
      };
    case "Inline":
      return {
        source: node,
        kind: "Inline",
        props: decodeOrThrow(Components.decodeInlinePropsEither(props), { sourcePath, node }),
        line,
      };
    default:
      return undefined;
  }
};
const parseStep = (node: MdxNode, sourcePath: string, hiddenReason?: string): GuideStepNode => {
  const props = decodeOrThrow(Components.decodeStepPropsEither(propsOf(node, sourcePath)), {
    sourcePath,
    node,
  });
  return {
    source: node,
    stepName: props.name,
    line: lineOf(node),
    hidden: hiddenReason !== undefined,
    ...(hiddenReason === undefined ? {} : { hiddenReason }),
    components: elementChildren(node)
      .map((child) => parseComponent(child, sourcePath))
      .filter((component): component is GuideStepComponent => component !== undefined),
  };
};
const parseBodyItem = (node: MdxNode, sourcePath: string): GuideScenarioBodyItem | undefined => {
  const raw = propsOf(node, sourcePath);
  switch (node.name) {
    case "Step":
      return { kind: "step", step: parseStep(node, sourcePath) };
    case "Hidden": {
      const props = decodeOrThrow(Components.decodeHiddenPropsEither(raw), { sourcePath, node });
      return {
        source: node,
        kind: "hidden",
        reason: props.reason,
        line: lineOf(node),
        steps: elementChildren(node)
          .filter((child) => child.name === "Step")
          .map((child) => parseStep(child, sourcePath, props.reason)),
      };
    }
    case "Skip": {
      const props = decodeOrThrow(Components.decodeSkipPropsEither(raw), { sourcePath, node });
      return {
        source: node,
        kind: "skip",
        reason: props.reason,
        ...(props.until === undefined ? {} : { until: props.until }),
        line: lineOf(node),
        steps: elementChildren(node)
          .filter((child) => child.name === "Step")
          .map((child) => parseStep(child, sourcePath)),
      };
    }
    case "Tabs": {
      const props = decodeOrThrow(Components.decodeTabsPropsEither(raw), { sourcePath, node });
      return {
        source: node,
        kind: "tabs",
        axis: props.axis ?? "default",
        line: lineOf(node),
        tabs: elementChildren(node)
          .filter((child) => child.name === "Tab")
          .map((tab) => {
            const tabProps = decodeOrThrow(Components.decodeTabPropsEither(propsOf(tab, sourcePath)), {
              sourcePath,
              node: tab,
            });
            return {
              source: tab,
              name: tabProps.name,
              line: lineOf(tab),
              steps: elementChildren(tab)
                .filter((child) => child.name === "Step")
                .map((child) => parseStep(child, sourcePath)),
            };
          }),
      };
    }
    default:
      return undefined;
  }
};
const parseScenario = (node: MdxNode, sourcePath: string): GuideScenarioNode => {
  const raw = propsOf(node, sourcePath);
  if (raw.render === false && (typeof raw.reason !== "string" || raw.reason.length < 8)) {
    throw new GuideHiddenScenarioReasonError({
      message: `<Scenario render={false}> at ${sourcePath} requires a reason of at least 8 characters.`,
      commandId: "guide.scenario.hidden-reason",
      sourcePath,
      scenarioId: typeof raw.id === "string" ? raw.id : "<unknown>",
      rejectedValue: undefined,
      remediation: "Add a colocated test-only scenario reason of at least 8 characters.",
    });
  }
  const props = decodeOrThrow(Components.decodeScenarioPropsEither(raw), { sourcePath, node });
  const body = elementChildren(node)
    .map((child) => parseBodyItem(child, sourcePath))
    .filter((item): item is GuideScenarioBodyItem => item !== undefined);
  return {
    ...props,
    source: node,
    line: lineOf(node),
    body,
    steps: body.flatMap((item) => {
      switch (item.kind) {
        case "step":
          return [item.step];
        case "hidden":
          return item.steps;
        case "tabs":
        case "skip":
          return [];
      }
    }),
  };
};
export const parseGuideRoot = (
  sourcePath: string,
  root: Root,
  options: { readonly presentation?: boolean; readonly frontmatter?: Record<string, unknown> } = {},
): GuideScenarioAst => {
  const [guide, duplicate] = elementChildren(root).filter((child) => child.name === "Guide");
  if (guide !== undefined && duplicate !== undefined) {
    const line = lineOf(duplicate);
    const relatedDeclarationLine = lineOf(guide);
    throw new GuideRootError({
      code: "guide.multiple-guides",
      sourcePath,
      line,
      relatedDeclarationLine,
      component: "Guide",
      message: `Multiple top-level <Guide> blocks at ${sourcePath}:${relatedDeclarationLine} and ${sourcePath}:${line}.`,
      remediation:
        "Combine all Scenario elements under one top-level <Guide> and remove the extra Guide blocks. Rerun bun run lint:guides and bun run codegen:guide-scenarios.",
    });
  }
  const walk = (node: MdxNode, parent: MdxNode, insideGuide = false): void => {
    if ((node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.name != null) {
      const known = Object.values(structureChildren).flat().includes(node.name);
      if (!options.presentation || insideGuide || known) {
        Components.assertSupportedGuideComponent(node.name, sourcePath);
        const parentName = parent.type === "mdxJsxFlowElement" ? (parent.name ?? parent.type) : parent.type;
        const inline = node.type === "mdxJsxTextElement";
        if (inline || !structureChildren[parentName]?.includes(node.name)) {
          const line = lineOf(node);
          const column = node.position?.start?.column ?? 1;
          throw new GuideStructureError({
            code: inline ? "guide.structure.inline" : "guide.structure.placement",
            sourcePath,
            line,
            column,
            component: node.name,
            parent: parentName,
            message: `Unsupported ${inline ? "inline" : "placement of"} <${node.name}> inside ${parentName} at ${sourcePath}:${line}:${column}.`,
            remediation:
              "Use block JSX with Guide at the document root, Scenario under Guide, Step/Hidden/Skip/Tabs under Scenario, Tab under Tabs, Step under Hidden/Skip/Tab, and executable leaves only under Step. Do not nest guide wrappers or place executable JSX in markdown prose. Rerun bun run lint:guides and bun run codegen:guide-scenarios.",
          });
        }
      }
    }
    for (const child of node.children ?? []) walk(child, node, insideGuide || node.name === "Guide");
  };
  walk(root, root);
  const frontmatter = decodeFrontmatter(
    sourcePath,
    options.frontmatter ?? parseFrontmatter(sourcePath, firstYaml(root)),
  );
  if (guide !== undefined) propsOf(guide, sourcePath);
  const ast = {
    sourcePath,
    frontmatter,
    root,
    guideLine: guide === undefined ? 1 : lineOf(guide),
    scenarios:
      guide === undefined
        ? []
        : elementChildren(guide)
            .filter((child) => child.name === "Scenario")
            .map((child) => parseScenario(child, sourcePath)),
  };
  return resolveGuide(ast);
};
export const parseGuideScenarioAst = (sourcePath: string, content: string): GuideScenarioAst =>
  parseGuideRoot(sourcePath, processor.parse(content));
