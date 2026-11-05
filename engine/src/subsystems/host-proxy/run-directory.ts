import { lstat } from "node:fs/promises";
import { PrivateFileAccessError } from "@lando/state-store/private-file-access";

export const verifyHostProxyRunDirectory = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new PrivateFileAccessError(directory);
  if (
    process.platform !== "win32" &&
    ((metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.())
  ) {
    throw new PrivateFileAccessError(directory);
  }
};
