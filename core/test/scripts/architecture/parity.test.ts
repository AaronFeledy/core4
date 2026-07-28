import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { expect, test } from "bun:test";

import { checkEnvHelperBoundary } from "../../../../scripts/check-env-helper-boundary.ts";
import { checkImportCycle } from "../../../../scripts/check-import-cycle.ts";
import { checkManagedFileBoundary } from "../../../../scripts/check-managed-file-boundary.ts";
import { checkPathsBoundary } from "../../../../scripts/check-paths-boundary.ts";
import { checkProbeBoundary } from "../../../../scripts/check-probe-boundary.ts";
import { checkRedactionBoundary } from "../../../../scripts/check-redaction-boundary.ts";
import { checkRendererBoundary } from "../../../../scripts/check-renderer-boundary.ts";
import { ARCHITECTURE_CORPUS } from "../fixtures/architecture-corpus.ts";

interface CanonicalDiagnostic {
  readonly ruleId: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly detail?: ReadonlyArray<string>;
}

interface DeferredCheckModules {
  readonly network: {
    readonly checkNetworkBoundary: (options: { readonly root?: string }) => Promise<{
      readonly offenders: ReadonlyArray<{
        readonly file: string;
        readonly line: number;
        readonly match: string;
      }>;
    }>;
  };
  readonly packageDag: {
    readonly checkPackageDag: (options: { readonly root: string }) => Promise<{
      readonly violations: ReadonlyArray<{
        readonly file: string;
        readonly line: number;
        readonly specifier: string;
      }>;
    }>;
  };
  readonly stateStore: {
    readonly checkStateStoreBoundary: (options: { readonly root?: string }) => Promise<{
      readonly offenders: ReadonlyArray<{
        readonly file: string;
        readonly signals: ReadonlyArray<string>;
      }>;
    }>;
  };
}

const RULE_IDS = [
  "env-helper-boundary",
  "import-cycle",
  "managed-file-boundary",
  "network-boundary",
  "package-dag",
  "paths-boundary",
  "probe-boundary",
  "redaction-boundary",
  "renderer-boundary",
  "state-store-boundary",
] as const;

const goldenPath = join(import.meta.dirname, "../fixtures/architecture-corpus.golden.json");

const repoRelative = (root: string, file: string): string =>
  (isAbsolute(file) ? relative(root, file) : file).replaceAll("\\", "/");

const isCanonicalDiagnostic = (value: unknown): value is CanonicalDiagnostic => {
  if (typeof value !== "object" || value === null) return false;
  if (!("ruleId" in value) || typeof value.ruleId !== "string") return false;
  if (!("file" in value) || typeof value.file !== "string") return false;
  if (!("message" in value) || typeof value.message !== "string") return false;
  if ("line" in value && typeof value.line !== "number") return false;
  return (
    !("detail" in value) ||
    (Array.isArray(value.detail) && value.detail.every((line) => typeof line === "string"))
  );
};

const readGolden = async (): Promise<ReadonlyArray<CanonicalDiagnostic>> => {
  const parsed: unknown = JSON.parse(await Bun.file(goldenPath).text());
  if (!Array.isArray(parsed) || !parsed.every(isCanonicalDiagnostic)) {
    throw new TypeError("Architecture golden must be an array of canonical diagnostics");
  }
  return parsed;
};

const materializeCorpus = async (root: string): Promise<void> => {
  for (const fixture of ARCHITECTURE_CORPUS) {
    const file = join(root, fixture.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, fixture.contents, "utf8");
  }
};

const collectDiagnostics = async (root: string): Promise<ReadonlyArray<CanonicalDiagnostic>> => {
  const [network, packageDag, stateStore]: [
    DeferredCheckModules["network"],
    DeferredCheckModules["packageDag"],
    DeferredCheckModules["stateStore"],
  ] = await Promise.all([
    import(new URL("../../../../scripts/check-network-boundary.ts", import.meta.url).href),
    import(new URL("../../../../scripts/check-package-dag.ts", import.meta.url).href),
    import(new URL("../../../../scripts/check-state-store-boundary.ts", import.meta.url).href),
  ]);
  const [
    renderer,
    managedFile,
    redaction,
    envHelper,
    dagResult,
    paths,
    storeResult,
    probe,
    netResult,
    cycle,
  ] = await Promise.all([
    checkRendererBoundary({ root }),
    checkManagedFileBoundary({ root }),
    checkRedactionBoundary({ root }),
    checkEnvHelperBoundary({ root }),
    packageDag.checkPackageDag({ root }),
    checkPathsBoundary({ root }),
    stateStore.checkStateStoreBoundary({ root }),
    checkProbeBoundary({ root }),
    network.checkNetworkBoundary({ root }),
    checkImportCycle({ root }),
  ]);

  // Legacy match/snippet/specifier fields become message; state signals are joined with no line;
  // package-DAG violations become diagnostics; each import cycle becomes one diagnostic with edge detail lines.
  const diagnostics: CanonicalDiagnostic[] = [
    ...renderer.offenders.map((offender) => ({
      ruleId: "renderer-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.match,
    })),
    ...managedFile.offenders.map((offender) => ({
      ruleId: "managed-file-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.match,
    })),
    ...redaction.offenders.map((offender) => ({
      ruleId: "redaction-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.match,
    })),
    ...envHelper.offenders.map((offender) => ({
      ruleId: "env-helper-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.specifier,
    })),
    ...dagResult.violations.map((violation) => ({
      ruleId: "package-dag",
      file: repoRelative(root, violation.file),
      line: violation.line,
      message: violation.specifier,
    })),
    ...paths.offenders.map((offender) => ({
      ruleId: "paths-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.snippet,
    })),
    ...storeResult.offenders.map((offender) => ({
      ruleId: "state-store-boundary",
      file: repoRelative(root, offender.file),
      message: offender.signals.join(", "),
    })),
    ...probe.offenders.map((offender) => ({
      ruleId: "probe-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.match,
    })),
    ...netResult.offenders.map((offender) => ({
      ruleId: "network-boundary",
      file: repoRelative(root, offender.file),
      line: offender.line,
      message: offender.match,
    })),
    ...cycle.cycles.map((entry) => ({
      ruleId: "import-cycle",
      file: entry.modules[0] ?? "",
      message: entry.modules.join(" -> "),
      detail: entry.edges.map(
        (edge) => `${edge.from}:${edge.line} imports ${edge.to} via ${JSON.stringify(edge.specifier)}`,
      ),
    })),
  ];

  return diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
};

test("preserves legacy architecture diagnostics when the corpus is scanned", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-architecture-corpus-"));
  try {
    await materializeCorpus(root);

    const diagnostics = await collectDiagnostics(root);
    const updating = process.env.LANDO_UPDATE_ARCHITECTURE_GOLDEN === "1";
    if (updating) await writeFile(goldenPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
    const golden = updating ? diagnostics : await readGolden();

    expect(diagnostics).toEqual(golden);
    expect([...new Set(golden.map((diagnostic) => diagnostic.ruleId))].sort()).toEqual([...RULE_IDS]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
