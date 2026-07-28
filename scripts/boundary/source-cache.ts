import ts from "typescript";

import { type ModuleEdge, scanModuleEdges } from "../module-edge-scan.ts";
import type { FileRecord } from "./types.ts";

export interface SourceCacheCounters {
  readonly parseCount: number;
  readonly cacheHitCount: number;
}

export class SourceCache {
  readonly #texts = new Map<string, Promise<string>>();
  readonly #sources = new Map<string, Promise<ts.SourceFile>>();
  readonly #edges = new Map<string, Promise<readonly ModuleEdge[]>>();
  #parseCount = 0;
  #cacheHitCount = 0;

  text(file: FileRecord): Promise<string> {
    const cached = this.#texts.get(file.absolutePath);
    if (cached !== undefined) {
      this.#cacheHitCount += 1;
      return cached;
    }
    const pending = Bun.file(file.absolutePath).text();
    this.#texts.set(file.absolutePath, pending);
    return pending;
  }

  sourceFile(file: FileRecord): Promise<ts.SourceFile> {
    const cached = this.#sources.get(file.absolutePath);
    if (cached !== undefined) {
      this.#cacheHitCount += 1;
      return cached;
    }
    const pending = this.text(file).then((text) => {
      this.#parseCount += 1;
      return ts.createSourceFile(file.absolutePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    });
    this.#sources.set(file.absolutePath, pending);
    return pending;
  }

  moduleEdges(file: FileRecord): Promise<readonly ModuleEdge[]> {
    const cached = this.#edges.get(file.absolutePath);
    if (cached !== undefined) {
      this.#cacheHitCount += 1;
      return cached;
    }
    const pending = this.text(file).then((text) => scanModuleEdges(file.absolutePath, text));
    this.#edges.set(file.absolutePath, pending);
    return pending;
  }

  counters(): SourceCacheCounters {
    return { parseCount: this.#parseCount, cacheHitCount: this.#cacheHitCount };
  }
}
