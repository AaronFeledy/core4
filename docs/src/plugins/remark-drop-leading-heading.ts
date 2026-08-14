import type { Root, RootContent } from "mdast";
import type { MdxFlowExpression } from "mdast-util-mdx";

const isMdxComment = (node: RootContent): node is MdxFlowExpression =>
  node.type === "mdxFlowExpression" &&
  node.value.trimStart().startsWith("/*") &&
  node.value.trimEnd().endsWith("*/");

export const remarkDropLeadingHeading =
  () =>
  (tree: Root): void => {
    for (const [index, node] of tree.children.entries()) {
      if (isMdxComment(node)) continue;
      if (node.type === "heading" && node.depth === 1) tree.children.splice(index, 1);
      return;
    }
  };
