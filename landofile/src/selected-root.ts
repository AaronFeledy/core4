import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { LandofileNotFoundError, LandofileParseError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { assertUnderRoot } from "./include-guard.ts";
import {
  LandofileLayersOmittedError,
  presentLandofileLayers,
  representativeLandofileLayer,
} from "./layers.ts";
import { assertReadableRoot } from "./load-context.ts";
import { type RootLoadInputs, compileLandofileRoot } from "./merge-validate.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";
import { projectLandofileRootName } from "./root-compile.ts";

/** Select effective layers at this root only, never by walking to a parent. */
export const selectLandofileRoot = Effect.fn("Landofile.selectRoot")(function* (input: {
  readonly appRoot: string;
  readonly inputs: RootLoadInputs;
  readonly omitLocalOverrides: boolean;
  readonly contained: boolean;
}) {
  const { inputs, contained } = input;
  const appRoot = contained
    ? yield* Effect.tryPromise({
        try: () => realpath(input.appRoot),
        catch: (cause) =>
          new LandofileParseError({
            message: `Cannot resolve the Landofile root ${input.appRoot}.`,
            filePath: input.appRoot,
            line: undefined,
            column: undefined,
            remediation: "Ensure the app root exists and is accessible, then retry.",
            cause,
          }),
      })
    : input.appRoot;
  yield* assertReadableRoot(appRoot, inputs);
  const layers = yield* presentLandofileLayers(appRoot, input);
  const representative = representativeLandofileLayer(layers);
  if (representative === undefined)
    return yield* input.omitLocalOverrides
      ? new LandofileLayersOmittedError(appRoot)
      : new LandofileNotFoundError({
          message: `No selected Landofile layer found at ${appRoot}.`,
          cwd: appRoot,
          remediation: "The app must have a Landofile layer that is not omitted.",
        });
  const lockfile = join(appRoot, ".lando.lock.yml");
  if (contained)
    yield* Effect.forEach(
      [...layers.map(({ filePath }) => filePath), lockfile],
      (filePath) =>
        Effect.tryPromise({
          try: () => assertUnderRoot(appRoot, filePath, filePath),
          catch: (cause) =>
            new LandofileParseError({
              message: `Landofile input ${filePath} resolves outside ${appRoot}.`,
              filePath,
              line: undefined,
              column: undefined,
              remediation: "Use Landofile inputs that remain inside the app root.",
              cause,
            }),
        }),
      { discard: true },
    );
  const lockfilePresent = contained && (yield* Effect.promise(() => Bun.file(lockfile).exists()));
  return { appRoot, layers, canonicalPath: representative.filePath, lockfile, lockfilePresent, contained };
});

type SelectedLandofileRoot = Effect.Success<ReturnType<typeof selectLandofileRoot>>;

const atSelectedRoot = (selection: SelectedLandofileRoot, inputs: RootLoadInputs): RootLoadInputs => ({
  ...inputs,
  templates: {
    ...inputs.templates,
    context: {
      ...(inputs.templates.context ?? {
        bootstrapLevel: "app",
        scope: "landofile",
        env: hostExpressionEnvironment(),
      }),
      appRoot: AbsolutePath.make(selection.appRoot),
    },
  },
});

export const projectSelectedLandofileRootName = (selection: SelectedLandofileRoot, inputs: RootLoadInputs) =>
  projectLandofileRootName(selection, atSelectedRoot(selection, inputs));

export const compileSelectedLandofileRoot = (
  selection: SelectedLandofileRoot,
  inputs: RootLoadInputs,
  pinPublication: "publish" | "defer",
) =>
  compileLandofileRoot(selection.appRoot, selection.canonicalPath, {
    inputs: atSelectedRoot(selection, inputs),
    selection,
    pinPublication,
  });
