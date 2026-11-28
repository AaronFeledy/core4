#!/usr/bin/env bun
import { resolve } from "node:path";
import { causeMessage } from "@lando/sdk/errors";
import { Schema } from "effect";
import { SUPPORTED_PHP_VERSIONS } from "../plugins/service-lando/src/services/default-images.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";
import {
  XDEBUG_PINS_PATH,
  type XdebugPin,
  type XdebugPins,
  XdebugUpdateError,
  isStableXdebug,
  newestXdebugFirst,
  parseXdebugPhpRange,
  readXdebugPins,
  supportsPhp,
  xdebugTarballUrl,
} from "./xdebug-pins.ts";

const RELEASES_URL = "https://api.github.com/repos/xdebug/xdebug/releases";
const RELEASE_PAGES = 3;
const PAGE_SIZE = 30;
const DOWNLOAD_LIMIT = 12;
const Releases = Schema.Array(Schema.Struct({ tag_name: Schema.String }));

export type XdebugFetch = (url: string, init?: RequestInit) => Promise<Response>;

// Scripts own their HTTP egress; the shipped runtime uses @lando/http-client.
const xdebugFetch: XdebugFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

// xdebug.org returns malformed responses when Bun reuses the connection.
const tarballRequest = { keepalive: false } satisfies RequestInit;

const discoverTags = async (request: XdebugFetch, token: string | undefined): Promise<string[]> => {
  const headers = new Headers({ Accept: "application/vnd.github+json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const tags: string[] = [];
  for (let page = 1; page <= RELEASE_PAGES; page += 1) {
    const url = `${RELEASES_URL}?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await request(url, { headers, redirect: "error" });
    if (!response.ok) throw new XdebugUpdateError(`${url}: HTTP ${response.status}`);
    const releases = Schema.decodeUnknownSync(Releases)(await response.json());
    tags.push(...releases.map((release) => release.tag_name));
    if (releases.length < PAGE_SIZE) break;
  }
  return tags;
};

export const refreshXdebugPins = async (
  previous: XdebugPins,
  options: {
    readonly request?: XdebugFetch;
    readonly baseline?: XdebugPins;
    readonly warn?: (message: string) => void;
  } = {},
): Promise<XdebugPins> => {
  const {
    request = xdebugFetch,
    baseline,
    warn = (message) => process.stderr.write(`${message}\n`),
  } = options;
  const assets = new Map<string, { readonly bytes: ArrayBuffer; readonly sha256: string }>();
  const download = async (url: string) => {
    const cached = assets.get(url);
    if (cached !== undefined) return cached;
    const response = await request(url, tarballRequest);
    if (!response.ok) throw new XdebugUpdateError(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const asset = { bytes, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex") };
    assets.set(url, asset);
    return asset;
  };

  const currentPins = [...Object.entries(baseline?.releases ?? {}), ...Object.entries(previous.releases)];
  for (const [php, pin] of currentPins) {
    try {
      const { sha256 } = await download(pin.url);
      if (sha256 !== pin.sha256) {
        throw new XdebugUpdateError(`SHA-256 mismatch: expected ${pin.sha256}, got ${sha256}`);
      }
    } catch (cause) {
      throw new XdebugUpdateError(`PHP ${php} pin ${pin.url}: ${causeMessage(cause)}`, { cause });
    }
  }

  const tags = newestXdebugFirst(
    await discoverTags(request, process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
  );
  // One bounded scan of the newest releases. Also consider verified current pins
  // outside that window so history limits cannot replace a proven stable pin with an alpha.
  const versions = newestXdebugFirst([
    ...tags.slice(0, DOWNLOAD_LIMIT),
    ...currentPins.map(([, pin]) => pin.version),
  ]);
  const picks = new Map<string, XdebugPin>();
  const phpLines = [...SUPPORTED_PHP_VERSIONS].sort();
  for (const version of versions) {
    const url = xdebugTarballUrl(version);
    try {
      const { bytes, sha256 } = await download(url);
      const xml = (await new Bun.Archive(bytes).files("package.xml")).get("package.xml");
      if (xml === undefined) throw new XdebugUpdateError("Missing package.xml");
      const pin = { ...parseXdebugPhpRange(await xml.text()), sha256, url, version };
      for (const php of phpLines) {
        const prior = picks.get(php);
        if (
          (prior === undefined || (!isStableXdebug(prior.version) && isStableXdebug(version))) &&
          supportsPhp(pin, php)
        ) {
          picks.set(php, pin);
        }
      }
    } catch (cause) {
      // A broken candidate must not block verifying and keeping the committed pins.
      warn(`Skipped Xdebug candidate ${url}: ${causeMessage(cause)}`);
      continue;
    }
    if (phpLines.every((php) => isStableXdebug(picks.get(php)?.version ?? ""))) break;
  }

  return {
    schemaVersion: 1,
    releases: Object.fromEntries(
      phpLines.map((php) => {
        const pin = picks.get(php);
        if (pin === undefined)
          throw new XdebugUpdateError(
            `No compatible Xdebug release found for PHP ${php} in the bounded release search.`,
          );
        return [php, pin];
      }),
    ),
  };
};

if (import.meta.main) {
  const [baselinePath, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new TypeError("Usage: bun run update:xdebug [baseline-pins]");
  const path = resolve(import.meta.dirname, "..", XDEBUG_PINS_PATH);
  const previous = await readXdebugPins(path);
  const candidate = await refreshXdebugPins(
    previous,
    baselinePath === undefined ? {} : { baseline: await readXdebugPins(baselinePath) },
  );
  if (Bun.deepEquals(previous, candidate)) {
    process.stdout.write("Verified all Xdebug pins; no changes.\n");
  } else {
    await writeFormattedOutput(path, `${JSON.stringify(candidate, null, 2)}\n`);
    process.stdout.write(`Verified current Xdebug pins and updated ${XDEBUG_PINS_PATH}.\n`);
  }
}
