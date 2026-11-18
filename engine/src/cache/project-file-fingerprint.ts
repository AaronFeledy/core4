export const MAX_PROJECT_FILE_BYTES = 1_048_576;

export type ProjectFileFingerprint = { readonly path: string } & (
  | { readonly present: false }
  | { readonly present: true; readonly size: number; readonly sha256: string }
);
