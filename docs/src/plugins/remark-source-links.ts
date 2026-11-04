import type { Definition, Link, LinkReference, Root } from "mdast";
import type { Node, Parent } from "unist";
import type { VFile } from "vfile";

import { type SourceLinkInventory, resolveSourceLink } from "../lib/source-links.ts";

export const remarkSourceLinks =
  (inventory: SourceLinkInventory) =>
  (tree: Root, file: VFile): void => {
    if (!file.path) return;
    const references = new Set<string>();
    const collect = (node: Node): void => {
      if (node.type === "linkReference") references.add((node as LinkReference).identifier);
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of (node as Parent).children) collect(child);
      }
    };
    collect(tree);
    const visit = (node: Node): void => {
      if (
        node.type === "link" ||
        (node.type === "definition" && references.has((node as Definition).identifier))
      ) {
        const link = node as Link | Definition;
        link.url = resolveSourceLink(link.url, file.path, inventory);
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of (node as Parent).children) visit(child);
      }
    };
    visit(tree);
  };
