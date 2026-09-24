import type { PrivateFileAccess } from "../../src/private-file-access.ts";

// Lock behavior fixtures include pre-existing files without a private Windows ACL.
// ACL enforcement and wiring are exercised by their dedicated suites.
export const lockTestAccess: PrivateFileAccess = {
  enforce: async () => undefined,
  verify: async () => undefined,
};
