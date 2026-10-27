#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveManifestRepository } from "./check-runtime-bundle-manifest.ts";
import { type FetchOverHttpsOptions, fetchOverHttps } from "./runtime-bundle-fetch.ts";
import { runtimeBundleRecipeUrls } from "./runtime-bundle-licenses.ts";
import {
  type RuntimeBundleSources,
  parseRuntimeBundleSources,
  readRuntimeBundleSources,
} from "./runtime-bundle-sources.ts";

const REQUEST_TIMEOUT_MS = 30_000;

export interface LicenseViolation {
  readonly url: string;
  readonly message: string;
}

export const checkRuntimeBundleLicenses = async (options: {
  readonly sources: unknown;
  readonly live?: boolean;
  readonly publishedRuntimeVersion?: string;
  readonly repository: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: FetchOverHttpsOptions["sleep"];
}): Promise<readonly LicenseViolation[]> => {
  let sources: RuntimeBundleSources;
  try {
    sources = parseRuntimeBundleSources(options.sources);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return [{ url: "metadata", message: cause.message }];
  }
  if (!options.live) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryOptions = options.sleep === undefined ? {} : { sleep: options.sleep };
  const texts = new Map<string, Set<string>>();
  const links = new Set<string>();
  for (const group of Object.values(sources.bundles)) {
    for (const component of group.components) {
      links.add(component.license.source);
      for (const text of component.license.texts) {
        const hashes = texts.get(text.url) ?? new Set<string>();
        hashes.add(text.sha256);
        texts.set(text.url, hashes);
      }
      // The release workflow checks before publishing, when runtime-v<new> does
      // not exist. Only check recipes when the committed published manifest
      // pins this version; nightly checks them after publication repins it.
      if (options.publishedRuntimeVersion === sources.runtimeVersion) {
        for (const url of runtimeBundleRecipeUrls(component, sources.runtimeVersion, options.repository))
          links.add(url);
      }
    }
  }
  const violations: LicenseViolation[] = [];
  for (const [url, hashes] of texts) {
    try {
      const bytes = await fetchOverHttps(url, {
        ...retryOptions,
        fetchImpl: (target) =>
          fetchImpl(target, { redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      });
      const actual = createHash("sha256").update(bytes).digest("hex");
      for (const expected of hashes) {
        if (actual !== expected)
          violations.push({ url, message: `sha256 mismatch: expected ${expected}, got ${actual}` });
      }
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      violations.push({ url, message: cause.message });
    }
  }
  for (const url of links) {
    try {
      await fetchOverHttps(url, {
        ...retryOptions,
        fetchImpl: async (target) => {
          let response = await fetchImpl(target, {
            method: "HEAD",
            redirect: "follow",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if ([403, 405, 501].includes(response.status)) {
            await response.body?.cancel();
            response = await fetchImpl(target, {
              method: "GET",
              redirect: "follow",
              headers: { Range: "bytes=0-0" },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
          }
          await response.body?.cancel();
          return new Response(null, { status: response.status });
        },
      });
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      violations.push({ url, message: cause.message });
    }
  }
  return violations;
};

const main = async (argv: readonly string[]): Promise<void> => {
  if (argv.includes("--help")) {
    console.log(
      "Usage: bun run check:runtime-bundle-licenses [--live]\nValidate pinned license metadata; --live verifies license bytes, source links, and published recipe links.",
    );
    return;
  }
  if (argv.some((arg) => arg !== "--live")) throw new Error(`Unknown argument: ${argv.join(" ")}`);
  const manifest: unknown = JSON.parse(
    await readFile(
      resolve(import.meta.dir, "../plugins/provider-lando/runtime-bundle-versions.json"),
      "utf8",
    ),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("runtimeVersion" in manifest) ||
    typeof manifest.runtimeVersion !== "string"
  ) {
    throw new Error("Published runtime manifest has no runtimeVersion");
  }
  const violations = await checkRuntimeBundleLicenses({
    sources: await readRuntimeBundleSources(),
    live: argv.includes("--live"),
    publishedRuntimeVersion: manifest.runtimeVersion,
    repository: await resolveManifestRepository(),
  });
  for (const violation of violations)
    console.error(`[check:runtime-bundle-licenses] ${violation.url}: ${violation.message}`);
  if (violations.length > 0) process.exitCode = 1;
  else
    console.log(
      `[check:runtime-bundle-licenses] OK (${argv.includes("--live") ? "offline + live" : "offline"}); recipe links checked only when sources match published runtime-v${manifest.runtimeVersion}`,
    );
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
