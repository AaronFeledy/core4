import { resolve } from "node:path";

import ts from "typescript";

export interface SourceFileCache {
  sourceFile(fileName: string, sourceText: string): ts.SourceFile;
}

export const createSourceFileCache = (): SourceFileCache => {
  const cache = new Map<string, ts.SourceFile>();
  return {
    sourceFile(fileName, sourceText) {
      const absolutePath = resolve(fileName);
      const cached = cache.get(absolutePath);
      if (cached !== undefined) return cached;
      const source = ts.createSourceFile(
        absolutePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      cache.set(absolutePath, source);
      return source;
    },
  };
};
