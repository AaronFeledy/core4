export const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
