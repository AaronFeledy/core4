import { resolve } from "node:path";

export const CATALOG_OUTPUT_PATHS = [
  ".github/workflows",
  "core/test/fixtures/compose/manifest.json",
  "docs/reference/commands.mdx",
  "docs/reference/compose-key-matrix.mdx",
  "images/php",
  "plugins/file-sync-mutagen/mutagen-versions.json",
  "recipes/*/.scaffold/*",
  "sdk/test/fixtures/bundled-plugin-manifests.json",
] as const;

export interface CodegenDriftResult {
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly ok: boolean;
}

export class GitStatusError extends Error {
  override readonly name = "GitStatusError";

  constructor(
    readonly root: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(
      stderr.length === 0
        ? `git status failed with exit code ${exitCode} in ${root}`
        : `git status failed in ${root}: ${stderr}`,
    );
  }
}

export class GitStatusParseError extends Error {
  override readonly name = "GitStatusParseError";

  constructor(readonly record: string) {
    super(`git status returned a malformed porcelain record: ${JSON.stringify(record)}`);
  }
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PASS_MESSAGE = "Codegen catalog is clean.\n";
const FAILURE_HEADLINE = "Codegen drift detected in generated catalog paths:";
const REMEDIATION = "Run `bun run codegen`, review the generated changes, and commit the intended outputs.";

const parsePorcelainRecords = (output: string): ReadonlyArray<string> => {
  const fields = output.split("\0");
  const dirtyPaths: string[] = [];
  let index = 0;

  while (index < fields.length) {
    const record = fields[index];
    index += 1;
    if (record === undefined || record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") throw new GitStatusParseError(record);

    const status = record.slice(0, 2);
    dirtyPaths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = fields[index];
      if (sourcePath === undefined || sourcePath.length === 0) throw new GitStatusParseError(record);
      dirtyPaths.push(sourcePath);
      index += 1;
    }
  }

  return dirtyPaths;
};

export interface CheckCodegenDriftOptions {
  readonly root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const checkCodegenDrift = async (
  options: CheckCodegenDriftOptions = {},
): Promise<CodegenDriftResult> => {
  const root = options.root ?? REPO_ROOT;
  const child = Bun.spawn({
    cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", ...CATALOG_OUTPUT_PATHS],
    cwd: root,
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new GitStatusError(root, exitCode, stderr.trim());

  const dirtyPaths = parsePorcelainRecords(stdout);
  return { dirtyPaths, ok: dirtyPaths.length === 0 };
};

if (import.meta.main) {
  const result = await checkCodegenDrift();
  if (result.ok) {
    process.stdout.write(PASS_MESSAGE);
  } else {
    process.stderr.write(
      `${FAILURE_HEADLINE}\n${result.dirtyPaths.map((path) => `- ${path}`).join("\n")}\n${REMEDIATION}\n`,
    );
    process.exitCode = 1;
  }
}
