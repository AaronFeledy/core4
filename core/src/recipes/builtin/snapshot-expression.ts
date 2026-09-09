import type { ExpressionNode } from "@lando/sdk/expressions";

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
export const encodedStringNode = (value: string): ExpressionNode => ({
  kind: "Call",
  callee: "b64decode",
  args: [{ kind: "Literal", value: base64(value) }],
});
