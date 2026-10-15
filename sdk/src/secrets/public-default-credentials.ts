/** Published development credentials, not private secret values. */
export const DEFAULT_PASSWORD = "lando";
export const MINIO_DEFAULT_PASSWORD = "landolando";

export const PUBLIC_DEFAULT_CREDENTIALS: readonly string[] = Object.freeze([
  DEFAULT_PASSWORD,
  MINIO_DEFAULT_PASSWORD,
]);

export const isPublicDefaultCredential = (value: string): boolean =>
  PUBLIC_DEFAULT_CREDENTIALS.includes(value);
