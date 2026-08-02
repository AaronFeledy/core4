import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Effect, Either, Schema } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import { ServiceCaFileDescriptor } from "@lando/sdk/services";

import type { BuildContextEntry } from "./build-context.ts";

export interface PreparedBuildStep {
  readonly command: string | ReadonlyArray<string>;
  readonly phase: string;
  readonly privileged: boolean;
  readonly caFiles: ReadonlyArray<ServiceCaFileDescriptor>;
}

export interface PreparedDerivedBuild {
  readonly steps: ReadonlyArray<PreparedBuildStep>;
  readonly caEntries: ReadonlyArray<BuildContextEntry>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const internalError = (providerId: string, message: string, cause?: unknown): ProviderInternalError =>
  new ProviderInternalError({
    providerId,
    operation: "buildArtifact",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const parseCaFiles = (
  value: unknown,
  providerId: string,
): Effect.Effect<ReadonlyArray<ServiceCaFileDescriptor>, ProviderInternalError> => {
  const decoded = Schema.decodeUnknownEither(Schema.Array(ServiceCaFileDescriptor))(value);
  return Either.isRight(decoded)
    ? Effect.succeed(decoded.right)
    : Effect.fail(
        internalError(providerId, "Invalid CA file descriptor in service build steps.", decoded.left),
      );
};

const parseStep = (
  value: unknown,
  providerId: string,
): Effect.Effect<PreparedBuildStep | undefined, ProviderInternalError> => {
  if (!isRecord(value)) return Effect.succeed(undefined);
  if (value.phase !== "build") return Effect.succeed(undefined);
  const caFiles = "caFiles" in value ? parseCaFiles(value.caFiles, providerId) : Effect.succeed([]);
  return caFiles.pipe(
    Effect.map((files) => {
      let command: string | ReadonlyArray<string>;
      if (typeof value.command === "string") {
        command = value.command;
      } else if (Array.isArray(value.command)) {
        command = value.command.filter((part): part is string => typeof part === "string");
        if (command.length !== value.command.length) return undefined;
      } else {
        return undefined;
      }
      return { command, phase: "build", privileged: value.privileged === true, caFiles: files };
    }),
  );
};

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

export const prepareDerivedBuild = (
  service: ServicePlan,
  providerId: string,
): Effect.Effect<PreparedDerivedBuild, ProviderInternalError> => {
  const extension = service.extensions["@lando/core/service-features"];
  const rawSteps = isRecord(extension) && Array.isArray(extension.buildSteps) ? extension.buildSteps : [];
  return Effect.gen(function* () {
    const parsed = yield* Effect.forEach(rawSteps, (step) => parseStep(step, providerId));
    const steps = parsed.filter((step) => step !== undefined);
    const descriptors = yield* uniqueDescriptors(steps, providerId);
    const caEntries = yield* Effect.forEach(
      descriptors,
      (descriptor) => readCaEntry(descriptor, providerId),
      {
        concurrency: "unbounded",
      },
    );
    return { steps, caEntries };
  });
};

export const copyInstructions = (step: PreparedBuildStep): ReadonlyArray<string> =>
  [...new Set(step.caFiles.map(({ archiveName }) => archiveName))]
    .sort()
    .map((archiveName) => `COPY .lando-ca/${archiveName} /usr/local/share/ca-certificates/${archiveName}`);
