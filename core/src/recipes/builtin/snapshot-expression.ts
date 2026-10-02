import type { ExpressionNode } from "@lando/sdk/expressions";

// Allocate at each call site: the snapshot budget treats aliased nodes as cycles.
export const lit = (value: string | number | boolean | null) =>
  ({ kind: "Literal", value }) satisfies ExpressionNode;

export const arr = (...elements: ExpressionNode[]) =>
  ({ kind: "ArrayLiteral", elements }) satisfies ExpressionNode;

export const obj = (entries: ReadonlyArray<readonly [string, ExpressionNode]>) =>
  ({
    kind: "ObjectLiteral",
    entries: entries.map(([key, value]) => ({ key, value })),
  }) satisfies ExpressionNode;

export const cond = (test: ExpressionNode, consequent: ExpressionNode, alternate: ExpressionNode) =>
  ({ kind: "Conditional", test, consequent, alternate }) satisfies ExpressionNode;

export const call = (callee: string, ...args: ExpressionNode[]) =>
  ({ kind: "Call", callee, args }) satisfies ExpressionNode;

export const defaultRoute = () =>
  obj([
    ["hostname", lit("{{ app.name }}.{{ proxy.defaultDomain }}")],
    ["scheme", lit("both")],
  ]);

export const toolNode = (
  service: string,
  description: string,
  cmds: string | ReadonlyArray<string | ExpressionNode>,
) =>
  obj([
    ["service", lit(service)],
    ["description", lit(description)],
    [
      "cmds",
      arr(
        ...(typeof cmds === "string" ? [cmds] : cmds).map((cmd) =>
          typeof cmd === "string" ? lit(cmd) : cmd,
        ),
      ),
    ],
  ]);

const base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Carry a string value that the restricted recipe-manifest YAML cannot hold
 * verbatim. `snapshot-yaml.ts` refuses double quotes, tabs, line breaks, and
 * whitespace before `#`, all of which appear in the multi-line shell scaffolds
 * and JSON settings blobs these recipes author. Base64 uses none of them, and
 * `b64decode` is already on the closed snapshot helper allowlist, so the
 * published snapshot stays inert declarative data.
 *
 * The readable source string stays in its own module; only its serialized form
 * is encoded. A fresh node is returned per call because the snapshot input
 * budget treats a repeated object reference as a cycle.
 */
export const encodedStringNode = (value: string): ExpressionNode => call("b64decode", lit(base64(value)));
