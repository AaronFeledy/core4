import type { Result } from "effect";
import * as Components from "../../sdk/src/docs/components/index.ts";
import { NotImplementedError } from "../../sdk/src/errors/index.ts";
import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import { type MdxNode, decodeOrThrow, elementChildren, propsOf } from "./mdx.ts";

export const walkAllNodes = (node: MdxNode, visitor: (node: MdxNode) => void): void => {
  visitor(node);
  for (const child of node.children ?? []) walkAllNodes(child, visitor);
};
const decoders: Readonly<Record<string, (input: unknown) => Result.Result<unknown, unknown>>> = {
  Step: Components.decodeStepPropsEither,
  Variable: Components.decodeVariablePropsEither,
  UseFixture: Components.decodeUseFixturePropsEither,
  Inspect: Components.decodeInspectPropsEither,
  Cleanup: Components.decodeCleanupPropsEither,
  Verify: Components.decodeVerifyPropsEither,
  Run: Components.decodeRunPropsEither,
};
export const lintComponentSyntax = (
  sourcePath: string,
  root: MdxNode,
): ReadonlyArray<GuideLintDiagnostic> => {
  const diagnostics: GuideLintDiagnostic[] = [];
  walkAllNodes(root, (node) => {
    if ((node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") || node.name == null) return;
    try {
      Components.assertSupportedGuideComponent(node.name, sourcePath);
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
      diagnostics.push(
        diagnostic(sourcePath, node, "guide.component.unsupported", `<${node.name}> is not supported yet.`),
      );
      return;
    }
    const props = propsOf(node, sourcePath);
    const reasonRule: readonly [code: string, message: string] | undefined =
      node.name === "Hidden"
        ? ["guide.hidden.reason", "<Hidden> requires a `reason` of at least 8 characters."]
        : node.name === "Skip"
          ? ["guide.skip.reason", "<Skip> requires a `reason` of at least 8 characters."]
          : node.name === "Scenario" && props.render === false
            ? [
                "guide.scenario.hidden-reason",
                "<Scenario render={false}> requires a `reason` of at least 8 characters.",
              ]
            : undefined;
    if (reasonRule !== undefined && (typeof props.reason !== "string" || props.reason.length < 8)) {
      diagnostics.push(diagnostic(sourcePath, node, reasonRule[0], reasonRule[1]));
      return;
    }
    if (
      node.name === "Inline" &&
      (typeof props.justification !== "string" || props.justification.length < 8)
    ) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.inline.justification",
          "<Inline> requires a `justification` of at least 8 characters.",
        ),
      );
      return;
    }
    const decode =
      node.name === "Scenario" && props.layer !== undefined
        ? Components.decodeScenarioPropsEither
        : decoders[node.name];
    if (decode === undefined) return;
    decodeOrThrow(decode(props), { sourcePath, node });
  });
  return diagnostics;
};
export const lintEditorial = (
  sourcePath: string,
  root: MdxNode,
  frontmatter: Record<string, unknown>,
): ReadonlyArray<GuideLintDiagnostic> => {
  const diagnostics: GuideLintDiagnostic[] = [];
  const guide = elementChildren(root).find((node) => node.name === "Guide");
  const scenarios =
    guide === undefined ? [] : elementChildren(guide).filter((node) => node.name === "Scenario");
  const shellLanguages = new Set(["bash", "sh", "zsh", "shell", "console"]);
  for (const scenario of scenarios) {
    let cleanup = false;
    walkAllNodes(scenario, (node) => {
      if (node.name === "Cleanup") cleanup = true;
      if (node.type === "code" && node.lang != null && shellLanguages.has(node.lang.toLowerCase()))
        diagnostics.push(
          diagnostic(
            sourcePath,
            node,
            "guide.shell-fence",
            `Raw fenced \`${node.lang}\` code block is not allowed inside <Scenario>; use <Run> or <Inline>.`,
          ),
        );
    });
    if ((propsOf(scenario, sourcePath).layer ?? frontmatter.defaultLayer) === "e2e" && !cleanup)
      diagnostics.push(
        diagnostic(
          sourcePath,
          scenario,
          "guide.scenario.e2e-cleanup",
          '<Scenario layer="e2e"> requires at least one <Cleanup> step so provider resources are torn down.',
        ),
      );
  }
  if (
    guide !== undefined &&
    Object.hasOwn(frontmatter, "diataxis") &&
    scenarios.some((node) => propsOf(node, sourcePath).render !== false) &&
    frontmatter.diataxis !== "tutorial" &&
    frontmatter.diataxis !== "how-to"
  )
    diagnostics.push(
      diagnostic(
        sourcePath,
        guide,
        "guide.diataxis",
        "`diataxis:` must be `tutorial` or `how-to` for guides containing rendered scenarios.",
      ),
    );
  return diagnostics;
};
