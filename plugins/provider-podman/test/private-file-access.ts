import type { PrivateFileAccess } from "@lando/state-store/private-file-access";

export const ownerOnlyFileAccess: PrivateFileAccess = {
  enforce: async () => undefined,
  verify: async () => undefined,
};
