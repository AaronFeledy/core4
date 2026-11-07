import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { layerWith as pluginRegistryLayer } from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeConfigTranslators } from "@lando/lando3";
import { emitLandofileYamlEither, landofileLayerRank } from "@lando/sdk/landofile";
import {
  ConfigTranslateDocumentSetInput,
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentNative,
  LandofileLayer,
} from "@lando/sdk/schema";
import { serviceTypeFacts } from "@lando/service-lando";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { loadLando3TranslatorPorts } from "../../src/recipes/lando3-ports.ts";

export const corpusRoot = join(import.meta.dir, "../../../plugins/lando3/test/fixtures/corpus");
const CorpusSet = Schema.Struct({ id: Schema.String, files: Schema.Array(Schema.String) });
const CorpusManifest = Schema.Struct({ documentSets: Schema.Array(CorpusSet) });
export const readCorpusSets = async () =>
  Schema.decodeUnknownSync(CorpusManifest)(await Bun.file(join(corpusRoot, "manifest.json")).json())
    .documentSets;

export const makeCorpusHarness = async () => {
  const ports = await loadLando3TranslatorPorts(serviceTypeFacts, undefined, {});
  const loader = makeConfigTranslators(ports).get("lando3");
  if (loader === undefined) throw new Error("Missing production lando3 translator");
  const translator = await loader();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      pluginRegistryLayer({ user: false, app: false }),
      makeTestStateStore().layer,
      BunFileSystem.layer,
    ),
  );
  const run = async (set: typeof CorpusSet.Type) => {
    const documents = await Promise.all(
      set.files.map(async (path) => {
        const bytes = await Bun.file(join(corpusRoot, path)).bytes();
        const name = basename(path);
        const layer = /^\.lando\.(base|dist|upstream|local|user)\.yml$/.exec(name)?.[1] ?? "canonical";
        return {
          sourceId: path,
          path: name,
          layerId: Schema.decodeUnknownSync(LandofileLayer)(layer),
          mediaType: "application/yaml",
          contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
          bytes: Buffer.from(bytes).toString("base64"),
        };
      }),
    );
    documents.sort((a, b) => landofileLayerRank(a.layerId) - landofileLayerRank(b.layerId));
    const input = Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
      _tag: "landofile-document-set",
      documents,
      mode: "full",
      selectedSourceIds: documents.map(({ sourceId }) => sourceId),
      writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
      currentLowerV4Fragments: [],
    });
    const translated = await Effect.runPromise(translator.translate(input).pipe(Effect.result));
    if (Result.isFailure(translated))
      return { stage: "translate", tag: translated.failure._tag, reason: translated.failure.message };
    const unsupported = translated.success.diagnostics.filter(({ kind }) => kind === "unsupported");
    if (unsupported.length > 0)
      return {
        stage: "unsupported",
        diagnostics: unsupported.map(({ sourceId, kind, keyPath, message }) => ({
          sourceId,
          kind,
          keyPath,
          message,
        })),
      };
    const root = await mkdtemp(join(tmpdir(), "lando3-corpus-"));
    try {
      for (const output of translated.success.outputs) {
        const decoded = Schema.decodeUnknownSync(LandofileAuthoringFragment)(output.fragment, {
          onExcessProperty: "error",
        });
        const native = Schema.encodeSync(LandofileAuthoringFragmentNative)(decoded, {
          onExcessProperty: "error",
        });
        const emitted = emitLandofileYamlEither(
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(native),
        );
        if (Result.isFailure(emitted))
          return { stage: "encode", tag: emitted.failure._tag, reason: emitted.failure.message };
        const name = output.targetLayer === "canonical" ? ".lando.yml" : `.lando.${output.targetLayer}.yml`;
        await Bun.write(join(root, name), emitted.success);
      }
      const lint = await runtime.runPromise(appConfigLint({ cwd: root }).pipe(Effect.result));
      if (Result.isFailure(lint))
        return {
          stage: "lint",
          tag: lint.failure._tag,
          reason: lint.failure.message.replaceAll(root, "<app>"),
        };
      if (lint.success.valid) return { stage: "valid" };
      return {
        stage: "lint",
        valid: false,
        violations: lint.success.violations
          .filter(({ severity }) => severity === "error")
          .map(({ rule, path, message }) => ({ rule, path, message: message.replaceAll(root, "<app>") })),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  return { run, dispose: () => runtime.dispose() };
};
