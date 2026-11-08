import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { ChildOutput, makeChildOutputPolicy } from "../../src/cli/child-output.ts";
import { processRunnerFor } from "../_support/process-runner.ts";

import { metaBunSpec } from "../../src/cli/command-specs/meta/bun.ts";
import { metaXSpec } from "../../src/cli/command-specs/meta/x.ts";
import { metaBun, metaX } from "../../src/cli/commands/bun.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

test("native Bun failure preserves the child's exact stdout and stderr", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      cliEntry,
      "--renderer=plain",
      "bun",
      "-e",
      'process.stdout.write("payload"); process.stderr.write("diagnostic"); process.exit(37)',
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(37);
  expect(stdout).toBe("payload");
  expect(stderr).toBe("diagnostic");
});

test.each(["text", "json", "yaml"] as const)(
  "real %s Bun proxy retains the caller's piped stdin descriptor",
  async (format) => {
    const child = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "--renderer=plain",
        ...(format === "text" ? [] : [`--format=${format}`]),
        "bun",
        "-e",
        'const text = await Bun.stdin.text(); await Bun.write(Bun.stdout, text); await Bun.write(Bun.stderr, "diagnostic");',
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write("descriptor-input\n");
    await child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    if (format === "text") {
      expect(stdout).toBe("descriptor-input\n");
      expect(stderr).toBe("diagnostic");
    } else {
      const envelope: unknown = format === "json" ? JSON.parse(stdout) : Bun.YAML.parse(stdout);
      expect(envelope).toMatchObject({
        ok: true,
        output: {
          chunks: [
            { _tag: "stdout", chunk: "descriptor-input\n" },
            { _tag: "stderr", chunk: "diagnostic" },
          ],
          truncated: false,
        },
      });
      expect(stderr).toBe("");
    }
  },
);

describe("meta:bun command", () => {
  test("invokes the BunSelfRunner with the passed argv", async () => {
    const seen: Array<{ cmd: ReadonlyArray<string>; env: Record<string, string>; cwd: string }> = [];
    const runner = processRunnerFor((input) =>
      Effect.sync(() => {
        seen.push({ cmd: [input.cmd, ...input.args], env: { ...input.env }, cwd: input.cwd ?? "" });
        return { exitCode: 0 };
      }),
    );
    const result = await Effect.runPromise(
      metaBun({ argv: ["--version"], execPath: "/usr/local/bin/bun" }).pipe(
        Effect.provideService(ProcessRunner, runner),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]?.cmd).toEqual(["/usr/local/bin/bun", "--version"]);
    expect(seen[0]?.env.BUN_BE_BUN).toBe("1");
    expect(seen[0]?.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBe("1");
  });

  test("propagates exit code from spawn", async () => {
    const runner = processRunnerFor(() => Effect.succeed({ exitCode: 42 }));
    const result = await Effect.runPromise(
      metaBun({ argv: ["test"], execPath: "/x" }).pipe(Effect.provideService(ProcessRunner, runner)),
    );
    expect(result.exitCode).toBe(42);
  });
});

describe("meta:x command", () => {
  test("missing package input returns a validation envelope and exit 2", async () => {
    const child = Bun.spawn([process.execPath, cliEntry, "--format=json", "x"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: { _tag: "CommandInputValidationError", target: "meta:x", field: "spec", reason: "required" },
    });
    expect(stderr).toBe("");
  });
  test("renders native help instead of executing bunx when no package payload is present", async () => {
    // Given / When
    const subprocess = Bun.spawn([process.execPath, cliEntry, "meta:x", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    // Then
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("ALIASES");
    expect(stdout).toContain("meta:x");
    expect(stderr).toBe("");
  });

  test("prefixes argv with `x <spec>` and prints the running banner", async () => {
    const seen: Array<{ cmd: ReadonlyArray<string> }> = [];
    const runner = processRunnerFor((input) =>
      Effect.sync(() => {
        seen.push({ cmd: [input.cmd, ...input.args] });
        return { exitCode: 0 };
      }),
    );
    const banners: string[] = [];
    const result = await Effect.runPromise(
      metaX({
        spec: "prettier",
        argv: ["--write", "."],
        execPath: "/x/bun",
        onBanner: (line) => banners.push(line),
      }).pipe(
        Effect.provideService(ProcessRunner, runner),
        Effect.provideService(
          ChildOutput,
          makeChildOutputPolicy({ native: true, stdin: true, stream: undefined }),
        ),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.spec).toBe("prettier");
    expect(seen[0]?.cmd).toEqual(["/x/bun", "x", "prettier", "--write", "."]);
    expect(banners[0]).toBe("Running prettier");
  });
});

const renderProxyCompletion = async <A extends { readonly exitCode: number }>(
  spec: LandoCommandSpec<A>,
  value: A,
) => {
  const completion = spec.completion;
  if (completion === undefined) throw new Error(`${spec.id} declares no completion policy`);
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await runWithRendererHandling(Effect.succeed(value), {
    runtime: Layer.empty,
    rendererMode: "plain",
    resultFormat: "json",
    command: spec.id,
    invocation: { commandId: spec.id, argv: [], args: {}, flags: {}, cwd: "/workspace" },
    resultSchema: spec.resultSchema,
    io,
    completion: (result) => completion(result, undefined),
    setExitCode: (code) => {
      codes.push(code);
    },
    formatError: () => "must not render",
  });
  return { codes, envelope: JSON.parse(io.stdout()) };
};

describe("meta proxy completion", () => {
  test.each([
    { spec: metaBunSpec, value: { exitCode: 1 } },
    { spec: metaBunSpec, value: { exitCode: 42 } },
    { spec: metaXSpec, value: { spec: "prettier", exitCode: 7 } },
  ] as const)(
    "$spec.id child exit $value.exitCode completes ok:false with the result retained",
    async ({ spec, value }) => {
      // Given
      process.exitCode = 0;
      // When
      const { codes, envelope } = await renderProxyCompletion<{ readonly exitCode: number }>(spec, value);
      // Then
      expect(envelope).toMatchObject({
        ok: false,
        result: value,
        error: { _tag: "LandoCommandError", exitCode: value.exitCode },
      });
      expect(codes).toEqual([value.exitCode]);
      expect(process.exitCode).toBe(0);
    },
  );
});
