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
const STABLE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/u;

export const isStableComposeGoTag = (tag: string): boolean => STABLE_TAG_PATTERN.test(tag);

export const parseComposeVendorPin = (value: unknown, pinPath: string): ComposeVendorPin => {
  if (!isRecord(value)) throw new ComposeVendorPinError(pinPath);
  const { tag, sourceUrl, sha256 } = value;
  if (
    typeof tag !== "string" ||
    !isStableComposeGoTag(tag) ||
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

export const composeVendorSourceUrl = (tag: string): string =>
  `https://raw.githubusercontent.com/compose-spec/compose-go/${tag}/schema/compose-spec.json`;

export const buildComposeVendorPin = (tag: string, bytes: ArrayBuffer): ComposeVendorPin => ({
  tag,
  sourceUrl: composeVendorSourceUrl(tag),
  sha256: sha256Hex(bytes),
});

const parseStableTag = (tag: string): readonly [number, number, number] | undefined => {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareStableTags = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number => {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  if (leftMinor !== rightMinor) return leftMinor - rightMinor;
  if (leftPatch !== rightPatch) return leftPatch - rightPatch;
  return 0;
};

export const selectNewerComposeGoTag = (
  currentTag: string,
  candidateTags: ReadonlyArray<string>,
): string | undefined => {
  const current = parseStableTag(currentTag);
  if (current === undefined) {
    throw new Error(`Unparseable current compose-go tag: ${currentTag}`);
  }

  let newest: { readonly tag: string; readonly version: readonly [number, number, number] } | undefined;
  for (const candidate of candidateTags) {
    const version = parseStableTag(candidate);
    if (version === undefined) continue;
    if (compareStableTags(version, current) <= 0) continue;
    if (newest === undefined || compareStableTags(version, newest.version) > 0) {
      newest = { tag: candidate, version };
    }
  }

  return newest?.tag;
};

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
