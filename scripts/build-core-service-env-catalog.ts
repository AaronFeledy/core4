#!/usr/bin/env bun
import { resolve } from "node:path";

import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "sdk/src/schema/generated/core-service-env.ts");
const SOURCES = [
  "plugins/service-lando/src/features/env.ts",
  "plugins/service-lando/src/features/certs.ts",
  "plugins/service-lando/src/features/security.ts",
  "plugins/service-lando/src/app-features/mailpit.ts",
  "plugins/service-lando/src/services/_creds-helpers.ts",
  "engine/src/subsystems/networking.ts",
  "engine/src/subsystems/host-proxy/transport-feature.ts",
  "engine/src/subsystems/host-proxy/session-env.ts",
] as const;

const CORE_ENV_KEY = /(?:["'`](LANDO(?:_[A-Z0-9]+)*)["'`]|\b(LANDO(?:_[A-Z0-9]+)*)\s*:)/gu;

export const collectCoreServiceEnvKeys = async (): Promise<ReadonlyArray<string>> => {
  const keys = new Set<string>();
  for (const source of SOURCES) {
    const content = await Bun.file(resolve(REPO_ROOT, source)).text();
    for (const match of content.matchAll(CORE_ENV_KEY)) {
      const key = match[1] ?? match[2];
      if (key !== undefined) keys.add(key);
    }
  }
  return [...keys].sort();
};

const renderModule = (keys: ReadonlyArray<string>): string => {
  const entries = keys.map((key) => `  ${JSON.stringify(key)},`).join("\n");
  return `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-core-service-env-catalog.ts\`.
 * Source of truth: runtime sites that inject core-owned service environment.
 */
export const CORE_SERVICE_ENV_KEYS = [
${entries}
] as const;

const CORE_SERVICE_ENV_KEY_SET: ReadonlySet<string> = new Set(CORE_SERVICE_ENV_KEYS);

export const isCoreServiceEnvKey = (key: string): boolean => CORE_SERVICE_ENV_KEY_SET.has(key);
`;
};

if (import.meta.main) {
  const keys = await collectCoreServiceEnvKeys();
  await writeFormattedOutput(OUTPUT, renderModule(keys));
  console.log(`[build-core-service-env-catalog] wrote ${OUTPUT} (${keys.length} keys)`);
}
