import { writeFileAtomic } from "@lando/state-store/atomic";

export interface WriteSecretAtomicOptions {
  readonly randomId?: () => string;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
  readonly removeFile?: (path: string, options: { readonly force: boolean }) => Promise<void>;
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
  const { removeFile, ...writeOptions } = options;
  await writeFileAtomic(path, content, {
    ...writeOptions,
    mode: 0o600,
    ownerOnly: "best-effort",
    ...(removeFile === undefined ? {} : { removeFile: (temp: string) => removeFile(temp, { force: true }) }),
  });
};
