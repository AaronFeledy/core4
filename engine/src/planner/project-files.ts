import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { type Context, Effect, Stream } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type {
  FileSystem,
  ServiceTypeProjectFileDeclaration,
  ServiceTypeProjectFileInput,
} from "@lando/sdk/services";

const MAX_PROJECT_FILE_BYTES = 1_048_576;

interface BoundedRead {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly bytes: number;
}

interface ProjectFileRequest {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly packageRoot: string;
  readonly declarations: ReadonlyArray<ServiceTypeProjectFileDeclaration>;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
}

const validationError = (input: ProjectFileRequest, message: string) =>
  new LandofileValidationError({
    message,
    file: `${input.appRoot}/.lando.yml`,
    issues: [`services.${input.serviceName}.packageRoot`],
  });

const containedPath = (
  input: ProjectFileRequest,
  authoredPath: string,
): Effect.Effect<string, LandofileValidationError> => {
  const absolute = resolve(input.appRoot, authoredPath);
  const rel = relative(input.appRoot, absolute);
  if (isAbsolute(authoredPath) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return Effect.fail(
      validationError(
        input,
        `Service ${input.serviceName} project path ${authoredPath} escapes the app root. Use an app-root-relative packageRoot.`,
      ),
    );
  }
  return Effect.succeed(absolute);
};

const assertNoSymlinkComponents = (
  input: ProjectFileRequest & { readonly fileSystem: Context.Tag.Service<typeof FileSystem> },
  absolute: string,
  allowMissing: boolean,
): Effect.Effect<boolean, LandofileValidationError> =>
  Effect.gen(function* () {
    const rel = relative(input.appRoot, absolute);
    const segments = rel === "" ? [] : rel.split(sep);
    let current = input.appRoot;
    for (const segment of segments) {
      current = resolve(current, segment);
      const stat = yield* input.fileSystem.lstat(current).pipe(
        Effect.map((value) => ({ kind: "present" as const, value })),
        Effect.catchTag("FileNotFoundError", () => Effect.succeed({ kind: "missing" as const })),
        Effect.mapError((cause) =>
          validationError(input, `Unable to inspect project path ${current}: ${cause.message}.`),
        ),
      );
      if (stat.kind === "missing") {
        if (allowMissing) return false;
        return yield* Effect.fail(
          validationError(
            input,
            `Service ${input.serviceName} packageRoot directory does not exist: ${input.packageRoot}. Create the directory or correct packageRoot.`,
          ),
        );
      }
      if (stat.value.isSymbolicLink === true) {
        return yield* Effect.fail(
          validationError(
            input,
            `Service ${input.serviceName} project path ${relative(input.appRoot, current)} is a symbolic link. Use regular files and directories contained in the app root.`,
          ),
        );
      }
    }
    return true;
  });

const readTextBounded = (
  input: ProjectFileRequest & { readonly fileSystem: Context.Tag.Service<typeof FileSystem> },
  absolute: string,
  limit: number,
): Effect.Effect<{ readonly text: string; readonly sha256: string }, LandofileValidationError> =>
  Stream.runFoldEffect(
    input.fileSystem.read(absolute),
    { chunks: [], bytes: 0 } as BoundedRead,
    (state, chunk): Effect.Effect<BoundedRead, LandofileValidationError> => {
      const bytes = state.bytes + chunk.byteLength;
      if (bytes > limit) {
        return Effect.fail(
          validationError(
            input,
            `Project-file inference input ${absolute} exceeds the ${limit}-byte read limit.`,
          ),
        );
      }
      return Effect.succeed({ chunks: [...state.chunks, chunk], bytes });
    },
  ).pipe(
    Effect.map((state) => {
      const content = new Uint8Array(state.bytes);
      let offset = 0;
      for (const chunk of state.chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        text: new TextDecoder().decode(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
    Effect.mapError((cause) =>
      cause instanceof LandofileValidationError
        ? cause
        : validationError(
            input,
            `Unable to read project file ${absolute}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          ),
    ),
  );

export const loadServiceTypeProjectFiles = (
  input: ProjectFileRequest,
): Effect.Effect<ReadonlyArray<ServiceTypeProjectFileInput>, LandofileValidationError> =>
  Effect.gen(function* () {
    if (input.declarations.length === 0) return [];
    if (input.fileSystem === undefined) {
      return yield* Effect.fail(
        validationError(
          input,
          `Service ${input.serviceName} requires project-file inference, but the FileSystem service is unavailable. Provide FileSystem or use an explicit service type.`,
        ),
      );
    }
    const request = { ...input, fileSystem: input.fileSystem };
    const packageRoot = yield* containedPath(input, input.packageRoot);
    yield* assertNoSymlinkComponents(request, packageRoot, false);
    const packageRootStat = yield* input.fileSystem
      .lstat(packageRoot)
      .pipe(
        Effect.mapError((cause) =>
          validationError(input, `Unable to inspect packageRoot ${packageRoot}: ${cause.message}.`),
        ),
      );
    if (!packageRootStat.isDirectory) {
      return yield* Effect.fail(
        validationError(
          input,
          `Service ${input.serviceName} packageRoot is not a directory: ${input.packageRoot}.`,
        ),
      );
    }

    const files: ServiceTypeProjectFileInput[] = [];
    for (const declaration of input.declarations) {
      const absolute = yield* containedPath(input, declaration.path);
      const present = yield* assertNoSymlinkComponents(request, absolute, true);
      const path = relative(input.appRoot, absolute);
      if (!present) {
        files.push({ path, present: false });
        continue;
      }
      const stat = yield* input.fileSystem
        .lstat(absolute)
        .pipe(
          Effect.mapError((cause) =>
            validationError(input, `Unable to inspect project file ${absolute}: ${cause.message}.`),
          ),
        );
      if (!stat.isFile) {
        return yield* Effect.fail(
          validationError(input, `Project-file inference input is not a file: ${absolute}.`),
        );
      }
      const limit = Math.min(declaration.maxBytes, MAX_PROJECT_FILE_BYTES);
      if (stat.size > limit) {
        return yield* Effect.fail(
          validationError(
            input,
            `Project-file inference input ${absolute} exceeds the ${limit}-byte read limit.`,
          ),
        );
      }
      const content = yield* readTextBounded(request, absolute, limit);
      files.push({ path, present: true, ...content });
    }
    return files;
  });
