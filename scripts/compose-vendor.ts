import { createHash } from "node:crypto";

export interface ComposeVendorPaths {
  readonly pinPath: string;
  readonly schemaPath: string;
}

export interface ComposeVendorPin {
  readonly tag: string;
  readonly sourceUrl: string;
  readonly sha256: string;
}

export interface ComposeVendorChecksumResult {
  readonly actualSha256: string;
  readonly expectedSha256: string;
  readonly ok: boolean;
}

export class ComposeVendorPinError extends Error {
  readonly pinPath: string;

  constructor(pinPath: string) {
    super(`Invalid Compose vendor pin: ${pinPath}`);
    this.name = "ComposeVendorPinError";
    this.pinPath = pinPath;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const parseComposeVendorPin = (value: unknown, pinPath: string): ComposeVendorPin => {
  if (!isRecord(value)) throw new ComposeVendorPinError(pinPath);
  const { tag, sourceUrl, sha256 } = value;
  if (
    typeof tag !== "string" ||
    !tag.startsWith("v") ||
    typeof sourceUrl !== "string" ||
    !sourceUrl.startsWith(`https://raw.githubusercontent.com/compose-spec/compose-go/${tag}/`) ||
    typeof sha256 !== "string" ||
    !SHA256_PATTERN.test(sha256)
  ) {
    throw new ComposeVendorPinError(pinPath);
  }
  return { tag, sourceUrl, sha256 };
};

export const readComposeVendorPin = async (pinPath: string): Promise<ComposeVendorPin> => {
  const parsed: unknown = JSON.parse(await Bun.file(pinPath).text());
  return parseComposeVendorPin(parsed, pinPath);
};

export const sha256Hex = (bytes: ArrayBuffer): string =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

export const verifyComposeVendorChecksum = async (
  paths: ComposeVendorPaths,
): Promise<ComposeVendorChecksumResult> => {
  const [pin, bytes] = await Promise.all([
    readComposeVendorPin(paths.pinPath),
    Bun.file(paths.schemaPath).arrayBuffer(),
  ]);
  const actualSha256 = sha256Hex(bytes);
  return {
    actualSha256,
    expectedSha256: pin.sha256,
    ok: actualSha256 === pin.sha256,
  };
};
