import { resolve } from "node:path";

import { readComposeVendorPin, sha256Hex } from "./compose-vendor.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PIN_PATH = resolve(REPO_ROOT, "spec/compose/vendor/pin.json");
const SCHEMA_PATH = resolve(REPO_ROOT, "spec/compose/vendor/compose-spec.json");

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

export const refreshComposeVendor = async (): Promise<void> => {
  const pin = await readComposeVendorPin(PIN_PATH);
  const response = await fetch(pin.sourceUrl);
  if (!response.ok) throw new ComposeVendorFetchError(pin.sourceUrl, response.status);

  const bytes = await response.arrayBuffer();
  if (sha256Hex(bytes) !== pin.sha256) throw new ComposeVendorFetchError(pin.sourceUrl);

  // Formatting would violate the byte-identical upstream pin.
  await Bun.write(SCHEMA_PATH, bytes);

  process.stdout.write(`[build-compose-vendor] wrote ${SCHEMA_PATH} (${pin.tag})\n`);
};

if (import.meta.main) await refreshComposeVendor();
