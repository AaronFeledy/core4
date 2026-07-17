import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AbsolutePath } from "@lando/sdk/schema";

export class TranscriptPathOutsideRootError extends Error {
  override readonly name = "TranscriptPathOutsideRootError";
  constructor(readonly path: AbsolutePath) {
    super(`Transcript path is outside the configured user data root: ${path}`);
  }
}

const isContained = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

export const assertTranscriptPathContained = async (
  userDataRoot: string,
  path: AbsolutePath,
): Promise<void> => {
  const lexicalRoot = resolve(userDataRoot);
  const lexicalPath = resolve(path);
  if (!isContained(lexicalRoot, lexicalPath)) throw new TranscriptPathOutsideRootError(path);
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(lexicalRoot), realpath(lexicalPath)]);
  if (!isContained(canonicalRoot, canonicalPath)) throw new TranscriptPathOutsideRootError(path);
};
