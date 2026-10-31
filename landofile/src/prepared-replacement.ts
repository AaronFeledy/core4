import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { getLocalIncludePaths } from "./include-provenance.ts";
import { landofileLayerPaths } from "./layers.ts";
import { getLandofileReferencedFiles } from "./load-expression-provenance.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import { validateLandofileReplacement } from "./replacement.ts";

const identity = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    const parent = dirname(path);
    if (parent === path) throw cause;
    return join(await identity(parent), basename(path));
  }
};

const sourceState = async (file: string) => {
  const target = await identity(file);
  try {
    return { file, target, digest: sha256Hex(await readFile(file)) };
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    return { file, target, digest: undefined };
  }
};

export const prepareLandofileReplacement = Effect.fn("Landofile.prepareReplacement")(function* (
  replacement: Parameters<typeof validateLandofileReplacement>[0],
  inputs: Parameters<typeof validateLandofileReplacement>[1],
) {
  const failure = (_cause: unknown) =>
    new LandofileWriteValidationError({
      file: replacement.targetFile,
      message: "Landofile inputs changed or could not be verified during preparation.",
      issues: [],
      remediation: "Retry explicitly to prepare and validate the current source files.",
    });
  const layers = landofileLayerPaths(replacement.appRoot).flatMap((layer) => [
    layer.yamlPath,
    layer.typescriptPath,
  ]);
  const before = yield* Effect.tryPromise({
    try: () => Promise.all([...layers, join(replacement.appRoot, ".lando.lock.yml")].map(sourceState)),
    catch: failure,
  });
  const landofile = yield* validateLandofileReplacement(replacement, { ...inputs, readOnly: true });
  const documents = getSourceDocuments(landofile.document).filter(
    (source) => source.file !== replacement.targetFile,
  );
  const references = getLandofileReferencedFiles(landofile.document);
  const files = [
    ...new Set([
      ...documents.map((source) => source.file),
      ...references.map((source) => source.absolutePath),
      ...getLocalIncludePaths(landofile.document),
    ]),
  ].filter(isAbsolute);
  const sources = yield* Effect.tryPromise({
    try: () => Promise.all(files.map(sourceState)),
    catch: failure,
  });
  const valid =
    documents.every((source) =>
      sources.some((current) => current.file === source.file && current.digest === source.digest),
    ) &&
    references.every((source) =>
      sources.some((current) => current.file === source.absolutePath && current.digest === source.sha256),
    );
  if (!valid) return yield* Effect.fail(failure(undefined));
  const expected = [...new Map([...sources, ...before].map((source) => [source.file, source])).values()];
  const root = yield* Effect.tryPromise({
    try: () => identity(resolve(replacement.appRoot)),
    catch: failure,
  });
  const verify = Effect.fn("Landofile.verifyPreparedReplacement")(function* () {
    const current = yield* Effect.tryPromise({
      try: async () => ({
        root: await identity(resolve(replacement.appRoot)),
        sources: await Promise.all(expected.map((source) => sourceState(source.file))),
      }),
      catch: failure,
    });
    if (current.root !== root || canonicalJson(current.sources) !== canonicalJson(expected))
      return yield* Effect.fail(failure(undefined));
  });
  yield* verify();
  return { landofile, verify: verify() };
});
