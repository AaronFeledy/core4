import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LandofileShape } from "@lando/core/schema";
import { ServiceName } from "@lando/core/schema";

import type { ComposeDispositionMatch } from "../../src/landofile/compose/rejections.ts";
import { assertNormalizedMatch } from "./compose-fixture-normalized-outcomes.ts";
import {
  ComposeFixtureOutcomeError,
  type OutcomeContext,
  fixtureEnvEntry,
  valueAt,
} from "./compose-fixture-outcome-values.ts";
import {
  matchedVolumes,
  preservedSourceValue,
  requirePresentValue,
  serviceDocumentPath,
} from "./compose-fixture-source-values.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const materializeFixtureEnvFiles = async (
  appRoot: string,
  landofile: LandofileShape,
): Promise<void> => {
  for (const [serviceName, service] of Object.entries(landofile.services ?? {})) {
    for (const [index, envFile] of (service.envFile ?? []).entries()) {
      const destination = join(appRoot, envFile);
      const [key, value] = fixtureEnvEntry(serviceName, index);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${key}=${value}\n`);
    }
  }
};

const assertPreservedMatch = (match: ComposeDispositionMatch, context: OutcomeContext): true => {
  if (match.service === undefined) throw new ComposeFixtureOutcomeError("Service match missing service name");
  const service = context.landofile.services?.[ServiceName.make(match.service)];
  if (service === undefined) throw new ComposeFixtureOutcomeError(`Missing decoded service ${match.service}`);
  const source = preservedSourceValue(match, service);
  requirePresentValue(source, match, "decoded service config");
  const compose = context.plan.services[ServiceName.make(match.service)]?.extensions.compose;
  if (!isRecord(compose)) throw new ComposeFixtureOutcomeError("Compose extension missing");

  if (match.matrixPath.startsWith("depends_on.*.restart")) {
    const dependencyName = serviceDocumentPath(match).split(".")[1];
    const produced = valueAt(compose, `depends_on.${dependencyName}.restart`);
    requirePresentValue(produced, match, "ServicePlan.extensions.compose.depends_on");
    expect(produced).toEqual(source);
    return true;
  }
  if (match.matrixPath.startsWith("healthcheck.start_interval")) {
    const produced = valueAt(compose, "healthcheck.start_interval");
    requirePresentValue(produced, match, "ServicePlan.extensions.compose.healthcheck.start_interval");
    expect(produced).toEqual(source);
    return true;
  }
  if (match.matrixPath.startsWith("volumes.tmpfs")) {
    const volume = matchedVolumes(match, service)[0];
    if (volume === undefined) throw new ComposeFixtureOutcomeError("Matched tmpfs volume missing");
    const entries = valueAt(compose, "tmpfs");
    const preserved = Array.isArray(entries)
      ? entries.find((entry) => valueAt(entry, "target") === volume?.target)
      : undefined;
    requirePresentValue(preserved, match, "ServicePlan.extensions.compose.tmpfs");
    const suffix = match.matrixPath.slice("volumes.tmpfs".length).replace(/^\./u, "");
    const produced = suffix.length === 0 ? preserved : valueAt(preserved, suffix);
    requirePresentValue(produced, match, `ServicePlan.extensions.compose.tmpfs.${suffix}`);
    expect(produced).toEqual(
      suffix.length === 0
        ? {
            target: volume?.target,
            ...(volume?.readOnly ? { read_only: true } : {}),
            ...(volume?.tmpfs ?? {}),
          }
        : source,
    );
    return true;
  }

  const relativePath = serviceDocumentPath(match);
  const produced = valueAt(compose, relativePath);
  requirePresentValue(produced, match, `ServicePlan.extensions.compose.${relativePath}`);
  expect(produced).toEqual(source);
  return true;
};

export const assertFixtureServiceOutcomes = (
  matches: ReadonlyArray<ComposeDispositionMatch>,
  context: OutcomeContext,
): number => {
  let assertionCount = 0;
  for (const match of matches) {
    if (match.service === undefined || match.disposition === "rejected") continue;
    switch (match.disposition) {
      case "normalized":
        if (assertNormalizedMatch(match, context)) assertionCount += 1;
        break;
      case "preserved":
        if (assertPreservedMatch(match, context)) assertionCount += 1;
        break;
      default: {
        const exhaustive: never = match.disposition;
        throw new ComposeFixtureOutcomeError(`Unhandled disposition: ${exhaustive}`);
      }
    }
  }
  return assertionCount;
};
