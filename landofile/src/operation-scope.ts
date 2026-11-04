import { AsyncLocalStorage } from "node:async_hooks";
import type { AppDiscoveryResolver } from "./traversal-policy.ts";

export interface DiscoveryOperation {
  readonly cwd: string;
  readonly resolver: AppDiscoveryResolver;
}

const operations = new AsyncLocalStorage<DiscoveryOperation>();

export const currentDiscoveryOperation = (): DiscoveryOperation | undefined => operations.getStore();

export const runDiscoveryOperation = <A>(operation: DiscoveryOperation, use: () => A): A =>
  operations.run(operation, use);
