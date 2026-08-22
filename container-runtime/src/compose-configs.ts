import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

export type ComposeConfigMount = {
  readonly source: string;
  readonly target: string;
  readonly readOnly: true;
  readonly mode?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseMode = (mode: unknown): number | undefined => {
  if (typeof mode === "number" && Number.isInteger(mode) && mode >= 0) return mode;
  if (typeof mode === "string" && mode.length > 0) {
    const parsed = Number.parseInt(mode, 8);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

const projectConfigs = (plan: AppPlan): Record<string, unknown> => {
  const compose = plan.extensions.compose;
  if (!isRecord(compose) || !isRecord(compose.configs)) return {};
  return compose.configs;
};

const serviceGrants = (service: ServicePlan): ReadonlyArray<Record<string, unknown>> => {
  const compose = service.extensions.compose;
  if (!isRecord(compose) || !Array.isArray(compose.configs)) return [];
  return compose.configs.filter(isRecord);
};

export const composeConfigMounts = (
  plan: AppPlan,
  service: ServicePlan,
): ReadonlyArray<ComposeConfigMount> => {
  const definitions = projectConfigs(plan);
  const mounts: Array<ComposeConfigMount> = [];
  for (const grant of serviceGrants(service)) {
    const sourceName = grant.source;
    if (typeof sourceName !== "string" || sourceName.length === 0) continue;
    const definition = definitions[sourceName];
    if (!isRecord(definition) || typeof definition.file !== "string" || definition.file.length === 0)
      continue;
    const source = resolve(plan.root, definition.file);
    const target =
      typeof grant.target === "string" && grant.target.length > 0 ? grant.target : `/${sourceName}`;
    const mode = parseMode(grant.mode);
    mounts.push({
      source,
      target,
      readOnly: true,
      ...(mode === undefined ? {} : { mode }),
    });
  }
  return mounts;
};

export const bindSourceForComposeConfig = (mount: ComposeConfigMount): string => {
  if (mount.mode === undefined) return mount.source;
  const digest = createHash("sha256").update(`${mount.source}:${mount.mode}`).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), "lando-compose-configs");
  mkdirSync(directory, { recursive: true });
  const realized = join(directory, digest);
  if (existsSync(realized)) chmodSync(realized, 0o600);
  copyFileSync(mount.source, realized);
  chmodSync(realized, mount.mode);
  return realized;
};

export const composeConfigBindStrings = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> =>
  composeConfigMounts(plan, service).map(
    (mount) => `${bindSourceForComposeConfig(mount)}:${mount.target}:ro`,
  );
