#!/usr/bin/env bun
import { resolve } from "node:path";

import type { ServiceType } from "@lando/sdk/services";
import { serviceTypes } from "@lando/service-lando";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "docs/reference/service-types.mdx");

export interface ServiceTypeVersionMatrix {
  readonly artifacts: Readonly<Record<string, string>>;
  readonly family: string;
  readonly versions: ReadonlyArray<string>;
}

export class ServiceTypeVersionMatrixError extends Error {
  override readonly name = "ServiceTypeVersionMatrixError";
}

const familyOf = (id: string): string => id.split(":", 1)[0] ?? id;

const matrixFor = (serviceType: ServiceType): ServiceTypeVersionMatrix | undefined => {
  const versions = serviceType.versions;
  if (versions === undefined) return undefined;
  if (versions.length === 0) {
    throw new ServiceTypeVersionMatrixError(
      `ServiceType ${serviceType.id} publishes an empty versions matrix.`,
    );
  }
  const artifacts = serviceType.artifacts ?? {};
  const missing = versions.filter((version) => artifacts[version] === undefined);
  const extra = Object.keys(artifacts).filter((version) => !versions.includes(version));
  if (missing.length > 0 || extra.length > 0) {
    throw new ServiceTypeVersionMatrixError(
      `ServiceType ${serviceType.id} version/artifact mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`,
    );
  }
  return { artifacts, family: familyOf(serviceType.id), versions };
};

export const serviceTypeVersionMatrices = (): ReadonlyArray<ServiceTypeVersionMatrix> => {
  const matrices = new Map<string, ServiceTypeVersionMatrix>();
  for (const serviceType of serviceTypes.values()) {
    const matrix = matrixFor(serviceType);
    if (matrix === undefined) continue;
    const existing = matrices.get(matrix.family);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(matrix)) {
      throw new ServiceTypeVersionMatrixError(
        `ServiceType family ${matrix.family} publishes inconsistent version metadata.`,
      );
    }
    matrices.set(matrix.family, matrix);
  }
  return [...matrices.values()].sort((left, right) => left.family.localeCompare(right.family));
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|");

export const renderServiceTypeReference = (): string => {
  const rows = serviceTypeVersionMatrices().map(
    ({ artifacts, family, versions }) =>
      `| \`${escapeCell(family)}\` | ${versions.map((version) => `\`${escapeCell(version)}\``).join(", ")} | ${versions.map((version) => `\`${escapeCell(artifacts[version] ?? "")}\``).join("<br />")} |`,
  );
  return [
    "---",
    "title: Service type versions",
    "description: Shipped service type versions and their pinned runtime artifacts.",
    "---",
    "",
    "{/* GENERATED FILE. Regenerate with `bun run codegen:service-type-reference`. */}",
    "",
    "# Service type versions",
    "",
    "These are the versioned service types shipped with Lando. A version not listed here is rejected before provider action. Bare service types without a published version matrix keep their intentional default image.",
    "",
    "| Type | Versions | Pinned artifacts |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

if (import.meta.main) await Bun.write(OUTPUT, renderServiceTypeReference());
