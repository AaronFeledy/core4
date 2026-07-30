import { Schema } from "effect";

export const LandofileLayer = Schema.Literal("base", "dist", "upstream", "canonical", "local", "user");
export type LandofileLayer = typeof LandofileLayer.Type;

export const FileRef = Schema.Struct({
  _tag: Schema.Literal("FileRef").annotations({ description: "File-reference discriminator." }),
  path: Schema.String.annotations({ description: "Resolved absolute path after symlink resolution." }),
  size: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  mime: Schema.String.annotations({ description: "MIME type inferred from the file extension." }),
  checksum: Schema.String.annotations({ description: "Lowercase hexadecimal SHA-256 of the file bytes." }),
  encoding: Schema.Literal("utf-8", "binary", "ascii").annotations({
    description: "Detected file encoding.",
  }),
}).annotations({ identifier: "FileRef", title: "File Reference" });
export type FileRef = typeof FileRef.Type;

const ImportRefMetadata = Schema.Struct({
  _tag: Schema.Literal("ImportRef").annotations({ description: "Import-reference discriminator." }),
  path: Schema.String.annotations({ description: "Path as authored in the source Landofile." }),
  basename: Schema.String.annotations({ description: "Basename of the authored path." }),
  checksum: Schema.String.annotations({
    description: "Lowercase hexadecimal SHA-256 of the imported bytes.",
  }),
  layer: LandofileLayer.annotations({ description: "Landofile layer that authored the import." }),
});

export const ImportRef = <A, I, R>(value: Schema.Schema<A, I, R>) =>
  Schema.extend(
    ImportRefMetadata,
    Schema.Struct({ value: value.annotations({ description: "Decoded imported value." }) }),
  );

export const StringImportRef = ImportRef(Schema.String).annotations({
  identifier: "StringImportRef",
  title: "String Import Reference",
});
export type StringImportRef = typeof StringImportRef.Type;
export type ImportRefValue<A> = Omit<StringImportRef, "value"> & { readonly value: A };
