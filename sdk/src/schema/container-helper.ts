import { Schema } from "effect";

import { AbsolutePath } from "./primitives.ts";
import { SHA256_HEX_PATTERN, patternString } from "./string-forms.ts";

// ==== In-container helper: one static Linux executable per architecture, resolved on the host

export const ContainerHelperArch = Schema.Literals(["x64", "arm64"]).annotate({
  description: "Linux architecture of the in-container helper executable.",
});
export type ContainerHelperArch = typeof ContainerHelperArch.Type;

export const ContainerHelperTarget = Schema.Struct({
  os: Schema.Literal("linux").annotate({ description: "OS family; only Linux helpers ship." }),
  arch: ContainerHelperArch,
}).annotate({ description: "Container platform the in-container helper is resolved for." });
export type ContainerHelperTarget = typeof ContainerHelperTarget.Type;

export const ContainerHelperDigest = patternString(SHA256_HEX_PATTERN, {
  title: "ContainerHelperDigest",
  description: "Lowercase hex SHA-256 of the helper executable.",
}).annotate({ description: "SHA-256 digest identifying a resolved helper executable." });
export type ContainerHelperDigest = typeof ContainerHelperDigest.Type;

export const ContainerHelperArtifact = Schema.Struct({
  target: ContainerHelperTarget,
  digest: ContainerHelperDigest,
  path: AbsolutePath.annotate({
    description: "Absolute host path of the static helper executable.",
  }),
}).annotate({ description: "Resolved in-container helper ready to bind-mount or copy into a container." });
export type ContainerHelperArtifact = typeof ContainerHelperArtifact.Type;
