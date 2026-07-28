import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type ComposeFixtureEntry,
  type ComposeFixtureSource,
  buildComposeFixturePin,
  composeFixtureSourceUrl,
  readComposeFixturePin,
} from "./compose-fixtures.ts";
import { sha256Hex } from "./compose-vendor.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "core/test/fixtures/compose");
const PIN_PATH = resolve(FIXTURES_ROOT, "pin.json");
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export class ComposeFixtureFetchError extends Error {
  readonly sourceUrl: string;
  readonly status: number | undefined;

  constructor(sourceUrl: string, status?: number) {
    super(
      status === undefined
        ? `Compose fixture checksum does not match the pin: ${sourceUrl}`
        : `Compose fixture fetch failed with HTTP ${status}: ${sourceUrl}`,
    );
    this.name = "ComposeFixtureFetchError";
    this.sourceUrl = sourceUrl;
    this.status = status;
  }
}

export class ComposeFixtureArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeFixtureArgsError";
  }
}

export type ComposeFixtureArgs =
  | { readonly mode: "verify" }
  | { readonly mode: "bump"; readonly ref: string };

export const parseComposeFixtureArgs = (argv: ReadonlyArray<string>): ComposeFixtureArgs => {
  let ref: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ref") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ComposeFixtureArgsError("--ref requires a value");
      }
      ref = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--ref=")) {
      ref = arg.slice("--ref=".length);
      continue;
    }
    throw new ComposeFixtureArgsError(`Unrecognized argument: ${arg}`);
  }

  if (ref === undefined) return { mode: "verify" };
  if (!COMMIT_PATTERN.test(ref)) {
    throw new ComposeFixtureArgsError(
      `conformance-tests ref must be a 40-character lowercase commit SHA: ${ref}`,
    );
  }
  return { mode: "bump", ref };
};

const fetchComposeFixtures = async (
  ref: string,
  entries: ReadonlyArray<ComposeFixtureEntry>,
): Promise<ReadonlyArray<ComposeFixtureSource>> =>
  Promise.all(
    entries.map(async ({ path, vendored }) => {
      const sourceUrl = composeFixtureSourceUrl(ref, path);
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new ComposeFixtureFetchError(sourceUrl, response.status);
      return { path, vendored, bytes: await response.arrayBuffer() };
    }),
  );

const writeComposeFixtures = async (files: ReadonlyArray<ComposeFixtureSource>): Promise<void> => {
  for (const file of files) {
    const destination = resolve(FIXTURES_ROOT, file.vendored);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, file.bytes);
  }
};

export const refreshComposeFixtures = async (): Promise<void> => {
  const pin = await readComposeFixturePin(PIN_PATH);
  const files = await fetchComposeFixtures(pin.ref, pin.files);
  for (const [index, file] of files.entries()) {
    const pinned = pin.files[index];
    if (pinned === undefined || sha256Hex(file.bytes) !== pinned.sha256) {
      throw new ComposeFixtureFetchError(composeFixtureSourceUrl(pin.ref, file.path));
    }
  }

  await writeComposeFixtures(files);
  process.stdout.write(`[build-compose-fixtures] wrote ${files.length} pinned files (${pin.ref})\n`);
};

export const bumpComposeFixtures = async (ref: string): Promise<void> => {
  const currentPin = await readComposeFixturePin(PIN_PATH);
  const files = await fetchComposeFixtures(ref, currentPin.files);
  const pin = buildComposeFixturePin(ref, files);

  await writeComposeFixtures(files);
  await Bun.write(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  process.stdout.write(`[build-compose-fixtures] bumped ${files.length} pinned files to ${ref}\n`);
};

// Deliberately excluded from scripts/codegen.ts: fixture refresh is a network-only maintenance command.
if (import.meta.main) {
  const args = parseComposeFixtureArgs(Bun.argv.slice(2));
  switch (args.mode) {
    case "bump":
      await bumpComposeFixtures(args.ref);
      break;
    case "verify":
      await refreshComposeFixtures();
      break;
    default: {
      const unhandled: never = args;
      throw new ComposeFixtureArgsError(`Unhandled fixture mode: ${unhandled}`);
    }
  }
}
