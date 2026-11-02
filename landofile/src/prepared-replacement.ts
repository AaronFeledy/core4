import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { getLocalIncludePaths } from "./include-provenance.ts";
import { publishIncludeProposals } from "./include-session.ts";
import { landofileLayerPaths } from "./layers.ts";
import { getLandofileReferencedFiles } from "./load-expression-provenance.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";
import { compileLandofileReplacement } from "./replacement.ts";

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

const prepareReplacement = Effect.fn("Landofile.prepareReplacement")(function* (
  replacement: Parameters<typeof compileLandofileReplacement>[0],
  inputs: Parameters<typeof compileLandofileReplacement>[1],
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
  const { landofile, session } = yield* compileLandofileReplacement(replacement, inputs);
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
  const expected = new Map([...sources, ...before].map((source) => [source.file, source]));
  const root = yield* Effect.tryPromise({
    try: () => identity(resolve(replacement.appRoot)),
    catch: failure,
  });
  const verify = Effect.fn("Landofile.verifyPreparedReplacement")(function* () {
    const current = yield* Effect.tryPromise({
      try: async () => ({
        root: await identity(resolve(replacement.appRoot)),
        sources: await Promise.all([...expected.keys()].map(sourceState)),
      }),
      catch: failure,
    });
    if (current.root !== root || canonicalJson(current.sources) !== canonicalJson([...expected.values()]))
      return yield* Effect.fail(failure(undefined));
  });
  yield* verify();
  const publishIncludes = Effect.gen(function* () {
    yield* publishIncludeProposals(session, inputs.stateStore);
    if (session.readOnly || session.selectedPins.size === 0) return;
    // Advance only our published lockfile witness, never the authored source witnesses.
    const lock = yield* Effect.tryPromise({
      try: () => sourceState(session.lockfilePath),
      catch: failure,
    });
    expected.set(lock.file, lock);
  });
  return { landofile, verify: verify(), publishIncludes };
});

export const prepareLandofileReplacement = (
  replacement: Parameters<typeof prepareReplacement>[0],
  inputs: Parameters<typeof prepareReplacement>[1],
) => prepareReplacement(replacement, { ...inputs, readOnly: true });

export const acquireLandofileReplacement = prepareReplacement;
