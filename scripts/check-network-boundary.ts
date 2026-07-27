import { resolve } from "node:path";

import { networkBoundaryRule } from "./architecture/rules/network-boundary.ts";
import { runArchitectureChecks } from "./architecture/runner.ts";

export interface NetworkBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface NetworkBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<NetworkBoundaryOffender>;
}

interface CheckNetworkBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkNetworkBoundary = async (
  options: CheckNetworkBoundaryOptions = {},
): Promise<NetworkBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    rules: [networkBoundaryRule],
    auditExceptions: false,
  });
  const offenders = result.diagnostics.map(({ file, line, message }) => ({
    file,
    line: line ?? 1,
    match: message,
  }));

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (offender: NetworkBoundaryOffender): string =>
  `${offender.file}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkNetworkBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Network boundary check passed.\n");
  } else {
    process.stderr.write(
      `Network boundary check failed. Lando-owned outbound HTTP must route through the HttpClient adapter (@lando/core HttpClient), not direct global fetch. Carve-outs are limited to BunSelfRunner package-manager ops and the standalone installer scripts.\n${result.offenders
        .map(formatOffender)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
