import { RecipeManifestValidationError, causeMessage } from "@lando/sdk/errors";
import { RecipeContentDigest, validationIssue } from "@lando/sdk/schema";
import type { RecipeFile } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { bundledRecipeContentSource } from "./builtin/scaffold-assets.ts";
import { readAuxiliaryScaffoldContent } from "./init-pipeline/files.ts";
import type { RecipeDeclarationOrigin } from "./manifest/origins.ts";
import { resolveRecipeDeclarationPath } from "./source-declaration-path.ts";

export interface ObservedRecipeContent {
  /** A fresh copy on every access keeps retained observations immutable. */
  readonly content: Uint8Array;
  readonly digest: RecipeContentDigest;
}

export const observedRecipeContent = (raw: string | Uint8Array): ObservedRecipeContent => {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : Uint8Array.from(raw);
  const digest = Schema.decodeUnknownSync(RecipeContentDigest)(
    `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
  );
  return Object.freeze({
    get content() {
      return bytes.slice();
    },
    digest,
  });
};

/** One invocation owns this memo; no observed file survives across resolutions. */
export const makeRecipeContentObserver = () => {
  const observations = new Map<string, ObservedRecipeContent>();
  return Effect.fnUntraced(function* (origin: RecipeDeclarationOrigin, file: RecipeFile) {
    const key = JSON.stringify([origin, file.src, origin.kind === "bundled" ? file.dest : undefined]);
    const previous = observations.get(key);
    if (previous !== undefined) return previous;
    if (origin.kind === "directory") yield* resolveRecipeDeclarationPath(origin, file.src);
    const raw = yield* Effect.tryPromise({
      try: () =>
        readAuxiliaryScaffoldContent({
          file: { src: file.src, dest: file.dest },
          appName: "",
          ...(origin.kind === "bundled"
            ? { contentSource: bundledRecipeContentSource(origin.id) }
            : { sourceRoot: origin.root }),
        }),
      catch: (cause) =>
        new RecipeManifestValidationError({
          source: origin.kind === "bundled" ? origin.id : origin.root,
          message: `Cannot observe recipe asset ${file.src}: ${causeMessage(cause)}`,
          issues: [
            validationIssue(["files", file.dest], "Provide a readable contained regular source file."),
          ],
        }),
    });
    if (origin.kind === "directory") yield* resolveRecipeDeclarationPath(origin, file.src);
    const observed = observedRecipeContent(raw);
    observations.set(key, observed);
    return observed;
  });
};
