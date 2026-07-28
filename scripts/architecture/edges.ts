import { resolve } from "node:path";

import { type ModuleEdge, scanModuleEdges } from "../module-edge-scan.ts";

export interface ModuleEdgeCache {
  moduleEdges(fileName: string, sourceText: string): ReadonlyArray<ModuleEdge>;
}

export const createModuleEdgeCache = (): ModuleEdgeCache => {
  const cache = new Map<string, ReadonlyArray<ModuleEdge>>();
  return {
    moduleEdges(fileName, sourceText) {
      const absolutePath = resolve(fileName);
      const cached = cache.get(absolutePath);
      if (cached !== undefined) return cached;
      const edges = scanModuleEdges(absolutePath, sourceText);
      cache.set(absolutePath, edges);
      return edges;
    },
  };
};
