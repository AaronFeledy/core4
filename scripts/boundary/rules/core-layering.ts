import { posix } from "node:path";

import type { ModuleEdge } from "../../module-edge-scan.ts";
import type { BoundaryRule, FileContext } from "../types.ts";

const isCliImport = (file: string, specifier: string): boolean => {
  if (!specifier.startsWith(".")) {
    return (
      specifier === "@lando/core/cli" ||
      specifier.startsWith("@lando/core/cli/") ||
      specifier.includes("core/src/cli/")
    );
  }
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target === "core/src/cli" || target.startsWith("core/src/cli/");
};

const onEdges = (edges: readonly ModuleEdge[], context: FileContext): void => {
  for (const edge of edges) {
    if (isCliImport(context.relativePath, edge.specifier)) {
      context.report({
        line: edge.line,
        detail: `imports CLI internals via ${JSON.stringify(edge.specifier)}`,
      });
    }
  }
};

export const coreLayeringRule = {
  id: "core-layering",
  scope: {
    roots: ["engine/src/app", "engine/src/operations", "engine/src/services"],
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Core layering check passed.",
  failureHeadline:
    "Core layering check failed. Engine app, operation, and service modules must not import the CLI shell; move shared behavior behind a non-CLI seam.",
  onEdges,
} satisfies BoundaryRule;
