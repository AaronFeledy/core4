import { statSync } from "node:fs";

/** Narrow host check: the path exists and is a Unix-domain socket. */
export const hostPathIsUnixSocket = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};
