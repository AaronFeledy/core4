import { relative, resolve, sep } from "node:path";
import { LandofileIncludeError } from "@lando/sdk/errors";
import { isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { materializeIncludeConditions } from "./include-conditions.ts";
import type { ResolveContext } from "./include-context.ts";
import { classify, normalizeInclude, parseGitInclude, parseNpmInclude } from "./include-source.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import { getSourceDocuments } from "./pipeline/source-table.ts";

export const includeVerifyConditions = (
  roots: readonly { readonly file: string; readonly document: Record<string, unknown> }[],
  scope: LandofileLoadScope,
) => {
  const documents = new Map(roots.map(({ file, document }) => [file, { document, disabled: false }]));
  const disabledSources = new Map<string, boolean>();
  const observeInclude: NonNullable<ResolveContext["observeInclude"]> = Effect.fnUntraced(
    function* (request, acquired, context) {
      const parent = documents.get(request.origin.file);
      let disabled = parent?.disabled ?? false;
      const authored =
        parent === undefined
          ? undefined
          : request.origin.path.reduce<unknown>(
              (value, key) =>
                isPlainRecord(value) || Array.isArray(value) ? Reflect.get(value, key) : undefined,
              mergeLandofiles([parent.document]),
            );
      if (
        !disabled &&
        isPlainRecord(authored) &&
        Object.hasOwn(authored, "when") &&
        !loadPathBlocked(scope.recorder, request.origin)
      ) {
        const recorder = createLoadFailureRecorder();
        recorder.recipeAvailable = scope.recorder?.recipeAvailable ?? true;
        const result = yield* materializeIncludeConditions(
          { includes: [{ source: "./annotation.yml", when: authored.when }] },
          {
            source: {
              sourcePath: request.origin.file,
              sourceRoot: context.sourceRoot,
              appRoot: context.sourceRoot,
              layer: request.origin.layer,
            },
            policy: DEFAULT_LANDOFILE_LOAD_POLICY,
            scope: { ...scope, recorder, pendingSites: [], includeMode: "conditional" },
          },
        ).pipe(Effect.result);
        disabled =
          Result.isSuccess(result) &&
          recorder.failures.length === 0 &&
          Array.isArray(result.success.includes) &&
          result.success.includes.length === 0;
      }
      const entry = normalizeInclude(request.entry);
      const identity = yield* Effect.try({
        try: () => {
          if (acquired?.fragment.locked) return acquired.fragment.sourceId;
          switch (classify(entry.source)) {
            case "git":
              return parseGitInclude(entry).sourceId;
            case "npm":
              return parseNpmInclude(entry).sourceId;
            case "local": {
              const remote = context.remoteOrigin;
              if (remote === undefined) return undefined;
              const path = relative(remote.snapshotRoot, resolve(context.sourceRoot, entry.source))
                .split(sep)
                .join("/");
              return `${remote.identity}/${path}`;
            }
            case "user":
              return undefined;
          }
        },
        catch: (cause) => {
          if (cause instanceof LandofileIncludeError) return cause;
          throw cause;
        },
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (identity !== undefined)
        disabledSources.set(identity, (disabledSources.get(identity) ?? true) && disabled);
      if (acquired !== undefined) {
        const file = getSourceDocuments(acquired.parsed)[0]?.file ?? acquired.fragment.filePath;
        documents.set(file, { document: acquired.parsed, disabled });
      }
    },
  );
  return { observeInclude, disabledSources };
};
