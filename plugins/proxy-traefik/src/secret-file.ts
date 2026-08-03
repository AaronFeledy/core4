import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

interface SecretWriteOptions {
  readonly mode: number;
}

export interface WriteSecretAtomicOptions {
  readonly randomId?: () => string;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
  readonly removeFile?: (path: string, options: { readonly force: boolean }) => Promise<void>;
  readonly writeFile?: (
    path: string,
    content: string | Uint8Array,
    options: SecretWriteOptions,
  ) => Promise<void>;
}

/**
 * Atomically write a secret file with owner-only permissions (0600).
 * Mode is applied on the temp file before rename so the live path never
 * briefly exists as a world-readable default.
 */
export const writeSecretAtomic = async (
  path: string,
  content: string | Uint8Array,
  options: WriteSecretAtomicOptions = {},
): Promise<void> => {
  const tempPath = `${path}.tmp-${process.pid}-${options.randomId?.() ?? randomUUID()}`;
  try {
    await (options.writeFile ?? writeFile)(tempPath, content, { mode: 0o600 });
    await (options.renameFile ?? rename)(tempPath, path);
  } catch (cause) {
    await (options.removeFile ?? rm)(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
};
