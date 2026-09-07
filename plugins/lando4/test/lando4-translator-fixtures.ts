import { Schema } from "effect";

import { ConfigTranslateDetectInput, ConfigTranslateDocumentSetInput } from "@lando/sdk/schema";
import type { ConfigTranslateInput, ConfigTranslateDetectInput as DetectInput } from "@lando/sdk/schema";

export const CANONICAL = [
  "name: myapp",
  "runtime: 4",
  "services:",
  "  web:",
  "    type: lando",
  '    port: "{{ env.PORT }}"',
  "",
].join("\n");
export const LOCAL = ["services:", "  web:", '    port: "{{ env.LOCAL_PORT }}"', ""].join("\n");
export const LEGACY = ["name: legacy", "recipe: lamp", "config:", "  php: '7.4'", ""].join("\n");

const digest = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;

interface DocumentSpec {
  readonly path: string;
  readonly layerId: string;
  readonly content: string;
  readonly mediaType?: string;
}

const document = ({ path, layerId, content, mediaType = "application/yaml" }: DocumentSpec) => ({
  sourceId: path,
  layerId,
  path,
  mediaType,
  contentDigest: digest(content),
  bytes: Buffer.from(new TextEncoder().encode(content)).toString("base64"),
});

export const makeInput = (options: {
  readonly documents: ReadonlyArray<DocumentSpec>;
  readonly mode?: "full" | "single-layer";
  readonly selected?: ReadonlyArray<string>;
  readonly writable?: ReadonlyArray<string>;
}): ConfigTranslateInput =>
  Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
    _tag: "landofile-document-set",
    documents: options.documents.map(document),
    mode: options.mode ?? "full",
    selectedSourceIds: options.selected ?? options.documents.map(({ path }) => path),
    currentLowerV4Fragments: [],
    writableLayerIds: options.writable ?? ["canonical", "local"],
  });

export const makeDetectInput = (documents: ReadonlyArray<DocumentSpec>): DetectInput =>
  Schema.decodeUnknownSync(ConfigTranslateDetectInput)({ documents: documents.map(document) });

export const canonicalOnly: ReadonlyArray<DocumentSpec> = [
  { path: ".lando.yml", layerId: "canonical", content: CANONICAL },
];
