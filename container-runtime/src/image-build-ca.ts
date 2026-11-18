import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProviderInternalError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import {
  type ArtifactBuildContextTree,
  ServiceBuildAcquisition,
  ServiceBuildDirectoryCommand,
  ServiceCaFileDescriptor,
} from "@lando/sdk/services";
import { Effect, Predicate, Result, Schema } from "effect";

import type { BuildContextEntry } from "./build-context.ts";
import { packVerifiedBuildTrees, treeArchivePath } from "./image-build-tree.ts";
import { validateDockerfileUser } from "./image-build-user.ts";

export interface PreparedBuildStep {
  readonly command: string | ReadonlyArray<string> | ServiceBuildDirectoryCommand;
  readonly phase: string;
  readonly user?: string;
  readonly caFiles: ReadonlyArray<ServiceCaFileDescriptor>;
  readonly acquisitions: ReadonlyArray<ServiceBuildAcquisition>;
}

export interface PreparedDerivedBuild {
  readonly steps: ReadonlyArray<PreparedBuildStep>;
  readonly entries: ReadonlyArray<BuildContextEntry>;
}

const internalError = (providerId: string, message: string, cause?: unknown): ProviderInternalError =>
  new ProviderInternalError({
    providerId,
    operation: "buildArtifact",
    message,
    ...(cause === undefined ? {} : { cause }),
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

const parseCaFiles = (
  value: unknown,
  providerId: string,
): Effect.Effect<ReadonlyArray<ServiceCaFileDescriptor>, ProviderInternalError> => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(ServiceCaFileDescriptor))(value);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        internalError(providerId, "Invalid CA file descriptor in service build steps.", decoded.failure),
      );
};

const parseStep = Effect.fnUntraced(function* (
  value: unknown,
  providerId: string,
): Effect.fn.Return<PreparedBuildStep | undefined, ProviderInternalError> {
  if (!Predicate.isObject(value)) return undefined;
  if (value.phase !== "build") return undefined;
  const caFiles = "caFiles" in value ? parseCaFiles(value.caFiles, providerId) : Effect.succeed([]);
  const user =
    "user" in value ? yield* validateDockerfileUser(value.user, "build step user", providerId) : undefined;
  const files = yield* caFiles;
  const acquisitions = Schema.decodeUnknownResult(Schema.Array(ServiceBuildAcquisition))(
    value.acquisitions ?? [],
  );
  if (Result.isFailure(acquisitions)) {
    return yield* Effect.fail(internalError(providerId, "Invalid acquisition in service build step."));
  }
  let command: PreparedBuildStep["command"];
  if (typeof value.command === "string") {
    command = value.command;
  } else if (Array.isArray(value.command)) {
    command = value.command.filter((part): part is string => typeof part === "string");
    if (command.length !== value.command.length) return undefined;
  } else if (Predicate.isObject(value.command) && "directories" in value.command) {
    const decoded = Schema.decodeUnknownResult(ServiceBuildDirectoryCommand)(value.command);
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        internalError(providerId, "Invalid image directory build command.", decoded.failure),
      );
    }
    command = decoded.success;
  } else {
    return undefined;
  }
  return {
    command,
    phase: "build",
    ...(user === undefined ? {} : { user }),
    caFiles: files,
    acquisitions: acquisitions.success,
  };
});

const uniqueDescriptors = (
  steps: ReadonlyArray<PreparedBuildStep>,
  providerId: string,
): Effect.Effect<ReadonlyArray<ServiceCaFileDescriptor>, ProviderInternalError> => {
  const byArchiveName = new Map<string, ServiceCaFileDescriptor>();
  for (const descriptor of steps.flatMap((step) => step.caFiles)) {
    const existing = byArchiveName.get(descriptor.archiveName);
    if (existing === undefined) {
      byArchiveName.set(descriptor.archiveName, descriptor);
      continue;
    }
    if (existing.path !== descriptor.path || existing.digest !== descriptor.digest) {
      return Effect.fail(
        internalError(providerId, `Conflicting CA descriptors use archive name ${descriptor.archiveName}.`),
      );
    }
  }
  return Effect.succeed(
    [...byArchiveName.values()].sort((left, right) => left.archiveName.localeCompare(right.archiveName)),
  );
};

const readCaEntry = (
  descriptor: ServiceCaFileDescriptor,
  providerId: string,
): Effect.Effect<BuildContextEntry, ProviderInternalError> =>
  Effect.tryPromise({
    try: () => readFile(descriptor.path),
    catch: (cause) => internalError(providerId, `Unable to read CA file ${descriptor.path}.`, cause),
  }).pipe(
    Effect.flatMap((content) => {
      const digest = createHash("sha256").update(content).digest("hex");
      return digest === descriptor.digest
        ? Effect.succeed({
            kind: "file" as const,
            name: `.lando-ca/${descriptor.archiveName}`,
            mode: 0o644,
            content,
          })
        : Effect.fail(internalError(providerId, `CA file digest mismatch for ${descriptor.path}.`));
    }),
  );

export const prepareDerivedBuild = Effect.fn("RuntimeProvider.prepareDerivedBuild")(function* (
  service: ServicePlan,
  providerId: string,
  contextTrees: readonly ArtifactBuildContextTree[] = [],
): Effect.fn.Return<PreparedDerivedBuild, ProviderInternalError> {
  const extension = service.extensions["@lando/core/service-features"];
  const rawSteps =
    Predicate.isObject(extension) && Array.isArray(extension.buildSteps) ? extension.buildSteps : [];

  const parsed = yield* Effect.forEach(rawSteps, (step) => parseStep(step, providerId));
  const steps = parsed.filter((step) => step !== undefined);
  const acquisitions = steps.flatMap((step) => step.acquisitions);
  const overlap = (left: string, right: string) =>
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const destinations = descriptorsForCopy(steps);
  const names = new Set<string>();
  for (const acquisition of acquisitions) {
    if (
      names.has(acquisition.contextName) ||
      destinations.some((destination) => overlap(destination, acquisition.destination))
    ) {
      return yield* Effect.fail(
        internalError(providerId, "Conflicting derived build context name or destination."),
      );
    }
    names.add(acquisition.contextName);
    destinations.push(acquisition.destination);
  }
  const byName = new Map(contextTrees.map((tree) => [tree.contextName, tree]));
  if (
    contextTrees.length !== acquisitions.length ||
    byName.size !== contextTrees.length ||
    acquisitions.some(({ contextName, destination }) => byName.get(contextName)?.destination !== destination)
  ) {
    return yield* Effect.fail(
      internalError(providerId, "Realized build trees do not match declared acquisitions."),
    );
  }
  const treeEntries = yield* Effect.tryPromise({
    try: () => packVerifiedBuildTrees(contextTrees),
    catch: (cause) =>
      internalError(
        providerId,
        `Unable to pack verified build context: ${cause instanceof Error ? cause.message : "read failed"}.`,
      ),
  });
  const descriptors = yield* uniqueDescriptors(steps, providerId);
  const caEntries = yield* Effect.forEach(descriptors, (descriptor) => readCaEntry(descriptor, providerId), {
    concurrency: "unbounded",
  });
  const directoryEntries: ReadonlyArray<BuildContextEntry> = steps.some(
    (step) => typeof step.command === "object" && "directories" in step.command,
  )
    ? [{ kind: "directory", name: ".lando-empty/", mode: 0o755 }]
    : [];
  return { steps, entries: [...caEntries, ...directoryEntries, ...treeEntries] };
});

const caDestination = (name: string) => `/usr/local/share/ca-certificates/${name}`;
const descriptorsForCopy = (steps: readonly PreparedBuildStep[]) =>
  steps.flatMap((step) => [
    ...step.caFiles.map(({ archiveName }) => caDestination(archiveName)),
    ...(typeof step.command === "object" && "directories" in step.command ? step.command.directories : []),
  ]);

export const copyInstructions = (step: PreparedBuildStep): ReadonlyArray<string> =>
  [...new Set(step.caFiles.map(({ archiveName }) => archiveName))]
    .sort()
    .map((archiveName) => `COPY .lando-ca/${archiveName} ${caDestination(archiveName)}`)
    .concat(
      step.acquisitions.map(
        ({ contextName, destination }) =>
          `COPY ${JSON.stringify([treeArchivePath(contextName), `${destination}/`])}`,
      ),
    );
