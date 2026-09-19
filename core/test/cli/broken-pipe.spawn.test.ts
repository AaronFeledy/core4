import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

const runPipeline = async (script: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-broken-pipe-"));
  try {
    const proc = Bun.spawn({
      cmd: ["bash", "-c", script],
      cwd: repoRoot,
      env: {
        ...process.env,
        BUN: process.execPath,
        ERR: join(root, "stderr"),
        OUT: join(root, "stdout"),
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_STATE_ROOT: join(root, "state"),
        LANDO_LOG_LEVEL: "none",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe.skipIf(process.platform === "win32")("broken CLI pipes", () => {
  test("pre-command --json key listing exits 141 when the consumer closes stdout", async () => {
    // Given / When: close the read end before starting the key-list command.
    const result = await runPipeline(
      '{ while [ ! -e "$OUT" ]; do :; done; "$BUN" core/bin/lando.ts version --json 2>"$ERR"; } | ' +
        '{ head -n 0; exec 0<&-; touch "$OUT"; }; echo "${PIPESTATUS[0]}"; wc -c <"$ERR"',
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "141\n0\n", stderr: "" });
  });

  test("stdout closed by an early-exiting consumer exits 141 with empty stderr", async () => {
    // Given / When: head closes without consuming any output.
    const result = await runPipeline(
      '"$BUN" core/bin/lando.ts config --format=json 2>"$ERR" | head -n 0; echo "${PIPESTATUS[0]}"; wc -c <"$ERR"',
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "141\n0\n", stderr: "" });
  });

  test("stderr closed by an early-exiting consumer does not corrupt the run", async () => {
    // Given / When: invalid format produces a diagnostic without touching a provider.
    const result = await runPipeline(
      '"$BUN" core/bin/lando.ts config --format=invalid 2>&1 >/dev/null | head -n 0; echo "${PIPESTATUS[0]}"',
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "141\n", stderr: "" });
  });

  test("the cold path survives a closed stdout", async () => {
    // Given / When
    const result = await runPipeline(
      '"$BUN" core/bin/lando.ts version 2>"$ERR" | head -n 0; echo "${PIPESTATUS[0]}"; wc -c <"$ERR"',
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "141\n0\n", stderr: "" });
  });

  test("a fully consumed pipe is unaffected", async () => {
    // Given: the un-piped output under the very same isolated roots.
    const result = await runPipeline(
      '"$BUN" core/bin/lando.ts config --format=json >"$OUT" || exit $?; ' +
        '"$BUN" core/bin/lando.ts config --format=json | cat; status=${PIPESTATUS[0]}; ' +
        'echo "status=$status"; cat "$OUT"; exit "$status"',
    );
    // When / Then: compare all bytes, not a buffer-size-dependent prefix.
    const [piped, direct] = result.stdout.split("status=0\n");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(piped).toBe(direct);
    expect(piped?.length).toBeGreaterThan(0);
  });
});
