/**
 * @lando/sdk/test — provider contract suite + library API contract suite.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite.
 * `@lando/core/testing` ships `TestRuntimeProvider` which MUST also pass it.
 *
 * Status: stub. The suite is defined as a single export `runProviderContractSuite`
 * that takes a Live Layer for `RuntimeProvider` and runs assertions against
 * it inside `bun test`. The full suite lands as features stabilize.
 */
import type { Layer } from "effect";

import type { RuntimeProvider } from "../services/index.ts";

export interface ProviderContractSuiteOptions {
  /** Tag identifier used in test descriptions. */
  readonly providerId: string;
  /** Live `RuntimeProvider` Layer under test. */
  readonly provider: Layer.Layer<RuntimeProvider, unknown, never>;
}

/**
 * Run the provider contract suite.
 *
 * TODO: implement the full suite covering:
 *   - capability reporting matches declared capabilities
 *   - apply is idempotent across repeated calls with the same plan
 *   - destroy removes everything apply created
 *   - exec against a missing service returns ServiceNotFoundError
 *   - logs produces a Stream that completes when the service stops
 *   - mount, endpoint, storage, route behavior matches the capability matrix
 *   - errors are tagged and contain remediation
 *   - cancellation propagates: an interrupted apply rolls back partial state
 */
export const runProviderContractSuite = (options: ProviderContractSuiteOptions): void => {
  // Intentionally empty until the suite lands.
  void options;
};
