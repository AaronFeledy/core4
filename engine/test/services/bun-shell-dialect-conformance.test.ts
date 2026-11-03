import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { bunShellDialectIssues } from "../../src/services/bun-shell-dialect.ts";

// Each command runs in its own directory with relative file names, so the suite is the same on
// Windows and POSIX and runs never share output files.
const workDirs: string[] = [];
afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

const runBunExec = async (
  command: string,
  env: Record<string, string> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const cwd = mkdtempSync(join(tmpdir(), "bun-shell-dialect-exec-"));
  workDirs.push(cwd);
  const proc = Bun.spawn([process.execPath, "exec", command], {
    cwd,
    env: { ...process.env, BUN_BE_BUN: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

describe("bun-shell-dialect conformance: flagged constructs diverge in real Bun", () => {
  test.each([
    {
      name: "braced plain is literal",
      command: "echo ${X}",
      env: { X: "val" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("${X}\n");
      },
    },
    {
      name: "braced default is literal",
      command: "echo ${NAME:-d}",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("${NAME:-d}\n");
      },
    },
    {
      name: "$? is literal",
      command: "false; echo $?",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$?\n");
      },
    },
    {
      name: "$@ is literal",
      command: "echo $@",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$@\n");
      },
    },
    {
      name: "$# is literal",
      command: "echo $#",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$#\n");
      },
    },
    {
      name: "$* fails as a glob",
      command: "echo $*",
      expect: (r: { exitCode: number; stderr: string }) => {
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr.length).toBeGreaterThan(0);
      },
    },
    {
      name: "$$ is literal",
      command: "echo $$",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$$\n");
      },
    },
    {
      name: "$! is literal",
      command: "echo $!",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$!\n");
      },
    },
    {
      name: "$- is literal",
      command: "echo $-",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("$-\n");
      },
    },
    {
      name: "$1 is empty under bun exec",
      command: "echo [$1]",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("[]\n");
      },
    },
    {
      name: "$0 expands to the command text under bun exec",
      command: "echo $0",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("echo $0");
      },
    },
    {
      name: "unterminated double quote is accepted",
      command: 'echo "abc',
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("abc\n");
      },
    },
    {
      name: ">&2 fails parse",
      command: "echo hi >&2",
      expect: (r: { exitCode: number; stderr: string }) => {
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/Redirection|Redirect/i);
      },
    },
    {
      name: "multiple redirections fail parse",
      command: "echo x > lando-bun-dialect-multi.out 2>&1",
      expect: (r: { exitCode: number; stderr: string }) => {
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/Redirect/i);
      },
    },
    {
      name: "arithmetic fails parse",
      command: "echo $((1+2))",
      expect: (r: { exitCode: number }) => {
        expect(r.exitCode).not.toBe(0);
      },
    },
    {
      name: "here-string fails parse",
      command: "echo <<<hi",
      expect: (r: { exitCode: number }) => {
        expect(r.exitCode).not.toBe(0);
      },
    },
    {
      name: "here-document does not feed stdin",
      command: "cat <<EOF\nhi\nEOF",
      expect: (r: { exitCode: number }) => {
        expect(r.exitCode).not.toBe(0);
      },
    },
    {
      name: "2>&- fails parse",
      command: "echo hi 2>&-",
      expect: (r: { exitCode: number }) => {
        expect(r.exitCode).not.toBe(0);
      },
    },
    {
      name: "&>&2 fails parse",
      command: "echo hi &>&2",
      expect: (r: { exitCode: number }) => {
        expect(r.exitCode).not.toBe(0);
      },
    },
    {
      name: "a#${X} prints literal braced text",
      command: "echo a#${X}",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("a#${X}\n");
      },
    },
  ] as const)("$name", async (row) => {
    const scannerIssues = bunShellDialectIssues(row.command);
    expect(scannerIssues.length).toBeGreaterThan(0);
    const result = await runBunExec(row.command, "env" in row ? row.env : {});
    row.expect(result);
  });
});

describe("bun-shell-dialect conformance: clean constructs work in real Bun", () => {
  test.each([
    {
      name: "bare $NAME expands",
      command: "echo $NAME",
      env: { NAME: "val" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("val\n");
      },
    },
    {
      name: "double-quoted $NAME expands",
      command: 'echo "$NAME"',
      env: { NAME: "val" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("val\n");
      },
    },
    {
      name: "single-quoted ${X} is literal characters",
      command: "echo '${X}'",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("${X}\n");
      },
    },
    {
      name: "escaped braced form is not expanded as a parameter",
      command: "echo \\${X}",
      env: { X: "val" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("${X}\n");
      },
    },
    {
      name: "double-quoted escaped braced form is not expanded",
      command: 'echo "\\${X}"',
      env: { X: "val" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("${X}\n");
      },
    },
    {
      name: "$(cmd) command substitution works",
      command: "echo $(echo ok)",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("ok\n");
      },
    },
    {
      name: "backtick command substitution works",
      command: "echo `echo ok`",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("ok\n");
      },
    },
    {
      name: "1>&2 works",
      command: "echo hi 1>&2",
      expect: (r: { exitCode: number; stdout: string; stderr: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("hi");
      },
    },
    {
      name: "2>&1 sends stderr to stdout",
      command: "cat lando-bun-dialect-missing 2>&1",
      expect: (r: { exitCode: number; stdout: string; stderr: string }) => {
        expect(r.stdout).toContain("lando-bun-dialect-missing");
        expect(r.stderr).toBe("");
      },
    },
    {
      name: "&>file works",
      command: "echo hi &> lando-bun-dialect-amp.out && cat lando-bun-dialect-amp.out",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("hi\n");
      },
    },
    {
      name: "&>>file works",
      command: "echo hi &>> lando-bun-dialect-amp-append.out && cat lando-bun-dialect-amp-append.out",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("hi");
      },
    },
    {
      name: "2>>file appends stderr to a file",
      command:
        "cat lando-bun-dialect-missing 2>>lando-bun-dialect-2append.out; cat lando-bun-dialect-2append.out",
      expect: (r: { exitCode: number; stdout: string; stderr: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("lando-bun-dialect-missing");
        expect(r.stderr).toBe("");
      },
    },
    {
      name: "input redirection reads a file",
      command: "echo data > lando-bun-dialect-in.txt && cat < lando-bun-dialect-in.txt",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("data\n");
      },
    },
    {
      name: "output redirection works",
      command: "echo a > lando-bun-dialect-out.out && cat lando-bun-dialect-out.out",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("a\n");
      },
    },
    {
      name: "brace expansion works",
      command: "echo {a,b}",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("a b\n");
      },
    },
    {
      name: "tilde expands",
      command: "echo ~",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe(homedir());
      },
    },
    {
      name: "comment at word start hides braced text",
      command: 'echo "a" #${X}',
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("a\n");
      },
    },
    {
      name: "assignment and $X work",
      command: "X=1; echo $X",
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("1\n");
      },
    },
    {
      name: "nested redirection counters compose",
      command: "echo $(cat lando-bun-dialect-missing 2>&1) 2>lando-bun-dialect-nested.err",
      expect: (r: { exitCode: number; stdout: string; stderr: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("lando-bun-dialect-missing");
        expect(r.stderr).toBe("");
      },
    },
    {
      name: "line continuation works",
      command: "echo $X\\\ny",
      env: { X: "a" },
      expect: (r: { exitCode: number; stdout: string }) => {
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("a y\n");
      },
    },
  ] as const)("$name", async (row) => {
    expect(bunShellDialectIssues(row.command)).toEqual([]);
    const result = await runBunExec(row.command, "env" in row ? row.env : {});
    row.expect(result);
  });
});

describe("bun-shell-dialect conformance: .bun.sh $1 binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-shell-dialect-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("$1 binds in a .bun.sh file and the scanner allows it", async () => {
    const scriptPath = join(dir, "bind.bun.sh");
    const body = "echo arg1=$1\n";
    writeFileSync(scriptPath, body, "utf8");
    expect(bunShellDialectIssues(body, { positional: "allow" })).toEqual([]);
    expect(bunShellDialectIssues(body).map((i) => i.text)).toEqual(["$1"]);

    const proc = Bun.spawn([process.execPath, scriptPath, "hello"], {
      cwd: dir,
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("arg1=hello\n");
  });
});

describe("bun-shell-dialect conformance: descriptor duplication and comments", () => {
  test.each(["echo x 3>&1", "echo x 1>&3", "echo x 0<&0", "echo x 2<&1"])(
    "%s fails to parse in Bun and is flagged",
    async (command) => {
      expect(bunShellDialectIssues(command).length).toBeGreaterThan(0);
      const result = await runBunExec(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Redirection with no file");
    },
  );

  test("a # after ; is a command word in Bun, so the braced form is flagged", async () => {
    expect(bunShellDialectIssues("echo x;#${X}").map((issue) => issue.text)).toEqual(["${X}"]);
    const result = await runBunExec("echo x;#${X}");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("x\n");
  });

  test.each([
    ["echo x 2>>&1", "x\n", ""],
    ["echo x 1>>&2", "", "x\n"],
    ["echo x2>&1", "x\n", ""],
  ])("%s runs and is not flagged", async (command, stdout, stderr) => {
    expect(bunShellDialectIssues(command)).toEqual([]);
    const result = await runBunExec(command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(stderr);
  });
});
