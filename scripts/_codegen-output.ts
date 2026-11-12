import { isAbsolute, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

type CodegenOutputPathErrorReason = "empty" | "outside-repository" | "repository-root";

const codegenOutputPathErrorMessage = {
  empty: () => "At least one non-empty generated path is required for Biome formatting.",
  "outside-repository": (path: string | undefined) =>
    `Generated path resolves outside the repository: ${path}`,
  "repository-root": () => "The repository root is not a generated output path.",
} satisfies Record<CodegenOutputPathErrorReason, (path: string | undefined) => string>;

export class CodegenOutputPathError extends Error {
  override readonly name = "CodegenOutputPathError";

  constructor(
    readonly reason: CodegenOutputPathErrorReason,
    readonly path: string | undefined,
  ) {
    super(codegenOutputPathErrorMessage[reason](path));
  }
}

export class CodegenOutputFormatError extends Error {
  override readonly name = "CodegenOutputFormatError";

  constructor(
    readonly exitCode: number,
    readonly paths: readonly string[],
    readonly output = "",
  ) {
    const detail = output.trim();
    super(
      `Biome check exited with code ${exitCode} for ${paths.join(", ")}.${detail === "" ? "" : `\n${detail.slice(0, 4000)}`}`,
    );
  }
}

export const biomeCheckArgv = (paths: readonly string[]): string[] => {
  if (paths.length === 0) throw new CodegenOutputPathError("empty", undefined);
  const relativePaths = paths.map((path) => {
    if (path.length === 0) throw new CodegenOutputPathError("empty", path);
    const normalized = relative(REPO_ROOT, resolve(path));
    if (normalized === "") throw new CodegenOutputPathError("repository-root", path);
    if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
      throw new CodegenOutputPathError("outside-repository", path);
    }
    return normalized;
  });
  return [
    process.execPath,
    "x",
    "--bun",
    "biome",
    "check",
    "--write",
    "--vcs-use-ignore-file=false",
    "--",
    ...relativePaths,
  ];
};

export const formatGeneratedPaths = async (paths: readonly string[]): Promise<void> => {
  const check = Bun.spawn({
    cmd: biomeCheckArgv(paths),
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(check.stdout).text(),
    new Response(check.stderr).text(),
    check.exited,
  ]);
  if (exitCode !== 0) throw new CodegenOutputFormatError(exitCode, paths, `${stdout}${stderr}`);
};

export const writeFormattedOutput = async (path: string, content: string): Promise<void> => {
  biomeCheckArgv([path]);
  await Bun.write(path, content);
  await formatGeneratedPaths([path]);
};
