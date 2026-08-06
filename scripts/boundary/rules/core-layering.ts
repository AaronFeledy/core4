import { posix } from "node:path";

import type { ModuleEdge } from "../../module-edge-scan.ts";
import type { BoundaryRule, FileContext } from "../types.ts";

type BurnDownEdge = Pick<ModuleEdge, "kind" | "specifier" | "typeOnly">;

export const CORE_LAYERING_BURN_DOWN_EDGES = {
  "core/src/app/handle.ts": [{ kind: "import", specifier: "../cli/commands/logs.ts", typeOnly: true }],
  "core/src/app/operations.ts": [
    { kind: "import", specifier: "../cli/commands/app-config-lint.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/destroy.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/exec.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/info.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/logs.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/rebuild.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/remote.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/restart.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/share.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/start.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/stop.ts", typeOnly: false },
    { kind: "import", specifier: "../cli/commands/tooling.ts", typeOnly: false },
  ],
} as const satisfies Readonly<Record<string, readonly BurnDownEdge[]>>;

const burnDownEdges: Readonly<Record<string, readonly BurnDownEdge[]>> = CORE_LAYERING_BURN_DOWN_EDGES;

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

const isBurnDownEdge = (file: string, edge: ModuleEdge): boolean =>
  (burnDownEdges[file] ?? []).some(
    (allowed) =>
      edge.kind === allowed.kind &&
      edge.specifier === allowed.specifier &&
      edge.typeOnly === allowed.typeOnly,
  );

const onEdges = (edges: readonly ModuleEdge[], context: FileContext): void => {
  for (const edge of edges) {
    if (isCliImport(context.relativePath, edge.specifier) && !isBurnDownEdge(context.relativePath, edge)) {
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
    roots: ["core/src/app", "core/src/services"],
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Core layering check passed.",
  failureHeadline:
    "Core layering check failed. App and service modules must not import the CLI shell; move shared behavior behind a non-CLI seam.",
  onEdges,
} satisfies BoundaryRule;
