import { isAbsolute, relative, sep } from "node:path";

/** Native-host lexical containment, including root equality; performs no filesystem IO. */
export const isPathWithin = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
