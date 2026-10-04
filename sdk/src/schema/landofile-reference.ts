import { Schema } from "effect";

export const LandofileLayer = Schema.Literals(["base", "dist", "upstream", "canonical", "local", "user"]);
export type LandofileLayer = typeof LandofileLayer.Type;

export const FileRef = Schema.Struct({
  _tag: Schema.Literal("FileRef").annotate({ description: "File-reference discriminator." }),
  path: Schema.String.annotate({ description: "Resolved absolute path after symlink resolution." }),
  size: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  mime: Schema.String.annotate({ description: "MIME type inferred from the file extension." }),
  checksum: Schema.String.annotate({ description: "Lowercase hexadecimal SHA-256 of the file bytes." }),
  encoding: Schema.Literals(["utf-8", "binary", "ascii"]).annotate({
    description: "Detected file encoding.",
  }),
}).annotate({ identifier: "FileRef", title: "File Reference" });
export type FileRef = typeof FileRef.Type;

const ImportRefMetadata = Schema.Struct({
  _tag: Schema.Literal("ImportRef").annotate({ description: "Import-reference discriminator." }),
  path: Schema.String.annotate({ description: "Path as authored in the source Landofile." }),
  basename: Schema.String.annotate({ description: "Basename of the authored path." }),
  checksum: Schema.String.annotate({
    description: "Lowercase hexadecimal SHA-256 of the imported bytes.",
  }),
  layer: LandofileLayer.annotate({ description: "Landofile layer that authored the import." }),
});

export const ImportRef = <A, I, R>(value: Schema.Codec<A, I, R, R>) =>
  ImportRefMetadata.pipe(
    Schema.fieldsAssign({ value: value.annotate({ description: "Decoded imported value." }) }),
  );

export const StringImportRef = ImportRef(Schema.String).annotate({
  identifier: "StringImportRef",
  title: "String Import Reference",
});
export type StringImportRef = typeof StringImportRef.Type;
export type ImportRefValue<A> = Omit<StringImportRef, "value"> & { readonly value: A };
