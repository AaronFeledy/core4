import type {
  CleanupProps,
  GuideFrontmatter,
  InlineProps,
  InspectProps,
  RunProps,
  UseFixtureProps,
  VariableProps,
  VerifyProps,
} from "@lando/sdk/docs/components";
import type { GuidePlatform } from "@lando/sdk/docs/components";
import type { Root } from "mdast";
import type { MdxNode } from "./mdx.ts";

export type GuideStepComponent = (
  | { readonly kind: "Run"; readonly props: RunProps; readonly line: number }
  | { readonly kind: "Verify"; readonly props: VerifyProps; readonly line: number }
  | { readonly kind: "Cleanup"; readonly props: CleanupProps; readonly line: number }
  | { readonly kind: "Variable"; readonly props: VariableProps; readonly line: number }
  | { readonly kind: "UseFixture"; readonly props: UseFixtureProps; readonly line: number }
  | { readonly kind: "Inspect"; readonly props: InspectProps; readonly line: number }
  | { readonly kind: "Inline"; readonly props: InlineProps; readonly line: number }
) & { readonly source?: MdxNode };

export interface GuideStepNode {
  readonly source?: MdxNode;
  readonly stepName: string;
  readonly line: number;
  readonly hidden: boolean;
  readonly hiddenReason?: string;
  readonly components: ReadonlyArray<GuideStepComponent>;
}
export interface GuideTabNode {
  readonly source?: MdxNode;
  readonly name: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}
export interface GuideTabsBlock {
  readonly source?: MdxNode;
  readonly kind: "tabs";
  readonly axis: string;
  readonly line: number;
  readonly tabs: ReadonlyArray<GuideTabNode>;
}
export interface GuideHiddenBlock {
  readonly source?: MdxNode;
  readonly kind: "hidden";
  readonly reason: string;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
}
export interface GuideSkipBlock {
  readonly source?: MdxNode;
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
  readonly source?: MdxNode;
  readonly id: string;
  readonly render: boolean;
  readonly reason?: string;
  readonly layer?: "scenario" | "e2e";
  readonly tags?: ReadonlyArray<string>;
  readonly line: number;
  readonly steps: ReadonlyArray<GuideStepNode>;
  readonly body: ReadonlyArray<GuideScenarioBodyItem>;
}
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
export interface ParsedGuide {
  readonly sourcePath: string;
  readonly frontmatter: GuideFrontmatter;
  readonly guideLine: number;
  readonly scenarios: ReadonlyArray<GuideScenarioNode>;
  readonly root: Root;
}
export interface GuideScenarioAst extends ParsedGuide {
  readonly cells: ReadonlyArray<{ readonly scenarioId: string; readonly resolved: ResolvedScenario }>;
}
export interface ResolvedScenario {
  readonly variant: GuideVariant | undefined;
  readonly steps: ReadonlyArray<GuideStepNode>;
  readonly publicSteps: ReadonlyArray<GuideStepNode>;
  readonly variables: ReadonlyMap<string, VariableProps>;
  readonly skips: ReadonlyArray<{ readonly stepName: string; readonly reason: string }>;
  readonly tabs: ReadonlyArray<{
    readonly axis: string;
    readonly value: string;
    readonly line: number;
    readonly source?: MdxNode;
  }>;
  readonly runMode: "cli" | "library";
  readonly skipOnly: boolean;
  readonly skipReason: string;
}
