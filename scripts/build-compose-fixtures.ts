import { resolve } from "node:path";

import { buildComposeFixtureManifest } from "./build-compose-fixture-manifest.ts";
import {
  type ComposeFixtureEntry,
  type ComposeFixtureSource,
  buildComposeFixturePin,
  composeFixtureSourceUrl,
  readComposeFixturePin,
} from "./compose-fixtures.ts";
import { sha256Hex } from "./compose-vendor.ts";
import { writeFixtureFileSafely } from "./fixture-safe-write.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "core/test/fixtures/compose");
const PIN_PATH = resolve(FIXTURES_ROOT, "pin.json");
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export interface ComposeFixtureMaintenance {
  readonly fixturesRoot: string;
  readonly pinPath: string;
  readonly fetchFixtures: (
    ref: string,
    entries: ReadonlyArray<ComposeFixtureEntry>,
  ) => Promise<ReadonlyArray<ComposeFixtureSource>>;
  readonly regenerateManifest: () => Promise<void>;
}

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

const writeComposeFixtures = async (
  fixturesRoot: string,
  files: ReadonlyArray<ComposeFixtureSource>,
): Promise<void> => {
  for (const file of files) {
    const destination = resolve(fixturesRoot, file.vendored);
    await writeFixtureFileSafely(fixturesRoot, destination, new Uint8Array(file.bytes));
  }
};

const DEFAULT_MAINTENANCE = {
  fixturesRoot: FIXTURES_ROOT,
  pinPath: PIN_PATH,
  fetchFixtures: fetchComposeFixtures,
  regenerateManifest: buildComposeFixtureManifest,
} satisfies ComposeFixtureMaintenance;

export const refreshComposeFixtures = async (maintenance: ComposeFixtureMaintenance): Promise<void> => {
  const pin = await readComposeFixturePin(maintenance.pinPath);
  const files = await maintenance.fetchFixtures(pin.ref, pin.files);
  for (const [index, file] of files.entries()) {
    const pinned = pin.files[index];
    if (pinned === undefined || sha256Hex(file.bytes) !== pinned.sha256) {
      throw new ComposeFixtureFetchError(composeFixtureSourceUrl(pin.ref, file.path));
    }
  }

  await writeComposeFixtures(maintenance.fixturesRoot, files);
  await maintenance.regenerateManifest();
  process.stdout.write(`[build-compose-fixtures] wrote ${files.length} pinned files (${pin.ref})\n`);
};

export const bumpComposeFixtures = async (
  ref: string,
  maintenance: ComposeFixtureMaintenance,
): Promise<void> => {
  const currentPin = await readComposeFixturePin(maintenance.pinPath);
  const files = await maintenance.fetchFixtures(ref, currentPin.files);
  const pin = buildComposeFixturePin(ref, files);

  await writeComposeFixtures(maintenance.fixturesRoot, files);
  await writeFixtureFileSafely(
    maintenance.fixturesRoot,
    maintenance.pinPath,
    `${JSON.stringify(pin, null, 2)}\n`,
  );
  await maintenance.regenerateManifest();
  process.stdout.write(`[build-compose-fixtures] bumped ${files.length} pinned files to ${ref}\n`);
};

// Deliberately excluded from scripts/codegen.ts: fixture refresh is a network-only maintenance command.
if (import.meta.main) {
  const args = parseComposeFixtureArgs(Bun.argv.slice(2));
  switch (args.mode) {
    case "bump":
      await bumpComposeFixtures(args.ref, DEFAULT_MAINTENANCE);
      break;
    case "verify":
      await refreshComposeFixtures(DEFAULT_MAINTENANCE);
      break;
    default: {
      const unhandled: never = args;
      throw new ComposeFixtureArgsError(`Unhandled fixture mode: ${unhandled}`);
    }
  }
}
