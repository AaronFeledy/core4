import type { LandofileLayer } from "@lando/sdk/schema";

export interface SourceDocument {
  readonly file: string;
  readonly form: "yaml" | "typescript";
  readonly layer: LandofileLayer;
  readonly document: unknown;
  readonly content: string;
  readonly digest: string;
}

const sources = new WeakMap<object, readonly SourceDocument[]>();
export const rememberSourceDocuments = <T extends object>(
  value: T,
  documents: readonly SourceDocument[],
): T => {
  sources.set(value, documents);
  return value;
};
export const getSourceDocuments = (value: object): readonly SourceDocument[] => sources.get(value) ?? [];
