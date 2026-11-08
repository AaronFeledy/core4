import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BaseSchemaArtifacts,
  SCHEMA_ARTIFACT_FAMILIES,
  type SchemaArtifactFamily,
  type SchemaArtifactSet,
  SchemaCompatibilityInputError,
  loadWorkingSchemaArtifacts,
} from "./schema-compatibility-artifacts.ts";

export const SCHEMA_SNAPSHOT_GENERATOR_PATH = SCHEMA_ARTIFACT_FAMILIES.sdk.generatorPath;

interface RegenerationRequest {
  readonly baseRef: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

interface CommandRequest {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (request: CommandRequest): Promise<CommandOutput> => {
  const child = Bun.spawn({
    cmd: [...request.command],
    cwd: request.cwd,
    env: request.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const requireSuccess = async (request: CommandRequest, message: string): Promise<CommandOutput> => {
  const output = await runCommand(request);
  if (output.exitCode === 0) return output;
  throw new SchemaCompatibilityInputError(message, output.stderr.trim() || output.stdout.trim());
};

const resolveBaseRef = async (request: RegenerationRequest): Promise<string> =>
  (
    await requireSuccess(
      {
        command: ["git", "rev-parse", "--verify", `${request.baseRef}^{commit}`],
        cwd: request.repoRoot,
        env: request.env ?? Bun.env,
      },
      `Schema compatibility base ref ${request.baseRef} is unavailable.`,
    )
  ).stdout.trim();

const unavailableSchemaFamilies = async (
  request: RegenerationRequest,
  commitSha: string,
): Promise<ReadonlyArray<SchemaArtifactFamily>> => {
  const output = await requireSuccess(
    {
      command: [
        "git",
        "ls-tree",
        "-z",
        "--full-tree",
        "--name-only",
        commitSha,
        "--",
        SCHEMA_SNAPSHOT_GENERATOR_PATH,
        SCHEMA_ARTIFACT_FAMILIES.persisted.generatorPath,
      ],
      cwd: request.repoRoot,
      env: request.env ?? Bun.env,
    },
    `Could not inspect schema compatibility base ${request.baseRef} for ${SCHEMA_SNAPSHOT_GENERATOR_PATH}.`,
  );
  const paths = new Set(output.stdout.split("\0"));
  return (["sdk", "command", "persisted"] as const).filter(
    (family) => !paths.has(SCHEMA_ARTIFACT_FAMILIES[family].generatorPath),
  );
};

const removeWorktree = async (
  request: RegenerationRequest,
  tempRoot: string,
  worktreeRoot: string,
): Promise<void> => {
  const cleanup = await runCommand({
    command: ["git", "worktree", "remove", "--force", worktreeRoot],
    cwd: request.repoRoot,
    env: request.env ?? Bun.env,
  });
  await rm(tempRoot, { recursive: true, force: true });
  if (cleanup.exitCode !== 0) {
    throw new SchemaCompatibilityInputError(
      `Could not remove isolated schema compatibility worktree for ${request.baseRef}.`,
      cleanup.stderr.trim() || cleanup.stdout.trim(),
    );
  }
};

export const regenerateBaseSchemaArtifacts = async (
  request: RegenerationRequest,
): Promise<BaseSchemaArtifacts> => {
  const commitSha = await resolveBaseRef(request);
  const unavailableFamilies = await unavailableSchemaFamilies(request, commitSha);
  if (unavailableFamilies.length === Object.keys(SCHEMA_ARTIFACT_FAMILIES).length) {
    return { artifacts: new Map(), unavailableFamilies };
  }

  const env = request.env ?? Bun.env;
  const tempRoot = await mkdtemp(join(tmpdir(), "lando-schema-compatibility-"));
  const worktreeRoot = join(tempRoot, "base");
  try {
    await requireSuccess(
      {
        command: ["git", "worktree", "add", "--detach", worktreeRoot, commitSha],
        cwd: request.repoRoot,
        env,
      },
      `Could not create isolated schema compatibility worktree for ${request.baseRef}.`,
    );
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  let artifacts: SchemaArtifactSet;
  try {
    await requireSuccess(
      {
        command: ["bun", "install", "--frozen-lockfile"],
        cwd: worktreeRoot,
        env,
      },
      `Could not install dependencies for schema compatibility base ${request.baseRef}.`,
    );
    await requireSuccess(
      {
        command: ["bun", "run", "codegen"],
        cwd: worktreeRoot,
        env,
      },
      `Could not regenerate schema compatibility baseline for ${request.baseRef}.`,
    );
    artifacts = await loadWorkingSchemaArtifacts(worktreeRoot, unavailableFamilies);
  } catch (error) {
    await removeWorktree(request, tempRoot, worktreeRoot);
    throw error;
  }
  await removeWorktree(request, tempRoot, worktreeRoot);
  return { artifacts, unavailableFamilies };
};
