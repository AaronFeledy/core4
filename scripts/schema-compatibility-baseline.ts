import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BaseSchemaArtifacts,
  type SchemaArtifactFamily,
  type SchemaArtifactSet,
  SchemaCompatibilityInputError,
  loadWorkingSchemaArtifacts,
} from "./schema-compatibility-artifacts.ts";

export const SCHEMA_SNAPSHOT_GENERATOR_PATH = "scripts/build-schema-snapshot.ts";

const UNAVAILABLE_FAMILIES = ["sdk", "command"] as const satisfies ReadonlyArray<SchemaArtifactFamily>;

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

const verifyBaseRef = async (request: RegenerationRequest): Promise<void> => {
  await requireSuccess(
    {
      command: ["git", "rev-parse", "--verify", `${request.baseRef}^{commit}`],
      cwd: request.repoRoot,
      env: request.env ?? Bun.env,
    },
    `Schema compatibility base ref ${request.baseRef} is unavailable.`,
  );
};

const hasSchemaSnapshotGenerator = async (request: RegenerationRequest): Promise<boolean> =>
  (
    await runCommand({
      command: ["git", "cat-file", "-e", `${request.baseRef}:${SCHEMA_SNAPSHOT_GENERATOR_PATH}`],
      cwd: request.repoRoot,
      env: request.env ?? Bun.env,
    })
  ).exitCode === 0;

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
  await verifyBaseRef(request);
  if (!(await hasSchemaSnapshotGenerator(request))) {
    return { artifacts: new Map(), unavailableFamilies: UNAVAILABLE_FAMILIES };
  }

  const env = request.env ?? Bun.env;
  const tempRoot = await mkdtemp(join(tmpdir(), "lando-schema-compatibility-"));
  const worktreeRoot = join(tempRoot, "base");
  try {
    await requireSuccess(
      {
        command: ["git", "worktree", "add", "--detach", worktreeRoot, request.baseRef],
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
        command: ["bun", "run", "codegen:schema-snapshot"],
        cwd: worktreeRoot,
        env,
      },
      `Could not regenerate schema compatibility baseline for ${request.baseRef}.`,
    );
    artifacts = await loadWorkingSchemaArtifacts(worktreeRoot);
  } catch (error) {
    await removeWorktree(request, tempRoot, worktreeRoot);
    throw error;
  }
  await removeWorktree(request, tempRoot, worktreeRoot);
  return { artifacts, unavailableFamilies: [] };
};
