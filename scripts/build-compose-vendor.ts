import { resolve } from "node:path";

import {
  buildComposeVendorPin,
  composeVendorSourceUrl,
  isStableComposeGoTag,
  readComposeVendorPin,
  sha256Hex,
} from "./compose-vendor.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PIN_PATH = resolve(REPO_ROOT, "vendor/compose/pin.json");
const SCHEMA_PATH = resolve(REPO_ROOT, "vendor/compose/compose-spec.json");

export class ComposeVendorFetchError extends Error {
  readonly sourceUrl: string;
  readonly status: number | undefined;

  constructor(sourceUrl: string, status?: number) {
    super(
      status === undefined
        ? `Compose schema checksum does not match the pin: ${sourceUrl}`
        : `Compose schema fetch failed with HTTP ${status}: ${sourceUrl}`,
    );
    this.name = "ComposeVendorFetchError";
    this.sourceUrl = sourceUrl;
    this.status = status;
  }
}

export class ComposeVendorArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeVendorArgsError";
  }
}

export type ComposeVendorArgs = { readonly mode: "verify" } | { readonly mode: "bump"; readonly tag: string };

export const parseComposeVendorArgs = (argv: ReadonlyArray<string>): ComposeVendorArgs => {
  let tag: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ComposeVendorArgsError("--tag requires a value");
      }
      tag = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
      continue;
    }
    throw new ComposeVendorArgsError(`Unrecognized argument: ${arg}`);
  }

  if (tag === undefined) return { mode: "verify" };
  if (!isStableComposeGoTag(tag)) {
    throw new ComposeVendorArgsError(`compose-go tag must be stable vMAJOR.MINOR.PATCH: ${tag}`);
  }
  return { mode: "bump", tag };
};

export interface ComposeVendorBumpInput {
  readonly tag: string;
  readonly bytes: ArrayBuffer;
  readonly pinPath: string;
  readonly schemaPath: string;
}

export const applyComposeVendorBump = async (input: ComposeVendorBumpInput): Promise<void> => {
  const pin = buildComposeVendorPin(input.tag, input.bytes);
  await Bun.write(input.schemaPath, input.bytes);
  await Bun.write(input.pinPath, `${JSON.stringify(pin, null, 2)}\n`);
};

export const refreshComposeVendor = async (): Promise<void> => {
  const pin = await readComposeVendorPin(PIN_PATH);
  const response = await fetch(pin.sourceUrl);
  if (!response.ok) throw new ComposeVendorFetchError(pin.sourceUrl, response.status);

  const bytes = await response.arrayBuffer();
  if (sha256Hex(bytes) !== pin.sha256) throw new ComposeVendorFetchError(pin.sourceUrl);

  // Write upstream bytes verbatim; formatting would break the pin checksum.
  await Bun.write(SCHEMA_PATH, bytes);

  process.stdout.write(`[build-compose-vendor] wrote ${SCHEMA_PATH} (${pin.tag})\n`);
};

export const bumpComposeVendor = async (tag: string): Promise<void> => {
  const sourceUrl = composeVendorSourceUrl(tag);
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new ComposeVendorFetchError(sourceUrl, response.status);

  const bytes = await response.arrayBuffer();
  await applyComposeVendorBump({ tag, bytes, pinPath: PIN_PATH, schemaPath: SCHEMA_PATH });

  process.stdout.write(`[build-compose-vendor] bumped ${SCHEMA_PATH} to ${tag}\n`);
};

if (import.meta.main) {
  const args = parseComposeVendorArgs(Bun.argv.slice(2));
  if (args.mode === "bump") await bumpComposeVendor(args.tag);
  else await refreshComposeVendor();
}
