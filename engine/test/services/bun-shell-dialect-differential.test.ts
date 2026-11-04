import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bunShellDialectIssues } from "../../src/services/bun-shell-dialect.ts";

const POSIX_CASES = [
  ["literal printf", "printf '%s\\n' hello"],
  ["multiple arguments", "printf '[%s]\\n' one two"],
  ["single quotes", "printf '%s\\n' 'two words $X'"],
  ["double quotes", 'printf "%s\\n" "two words"'],
  ["adjacent quotes", "printf '%s\\n' pre'fix'\"suffix\""],
  ["empty argument", "printf '<%s>\\n' ''"],
  ["escaped space", "printf '%s\\n' two\\ words"],
  ["escaped dollar", "printf '%s\\n' \\$X"],
  ["escaped quote", 'printf "%s\\n" "a\\"b"'],
  ["literal hash", "printf '%s\\n' x#y"],
  ["trailing comment", "printf '%s\\n' ok # ignored $X"],
  ["comment line", "# ignored\nprintf '%s\\n' ok"],
  ["bare variable", "printf '%s\\n' $WORD"],
  ["quoted variable", 'printf "<%s>\\n" "$X"'],
  ["quoted variable suffix", 'printf "%s\\n" "$WORD"suffix'],
  ["quoted empty variable", 'printf "<%s>\\n" "$EMPTY"'],
  ["unquoted empty variable", "printf '<%s>\\n' before $EMPTY after"],
  ["quoted missing variable", 'printf "<%s>\\n" "$DIFFERENTIAL_UNSET"'],
  ["assignment", "LOCAL=hello; printf '%s\\n' $LOCAL"],
  ["quoted assignment", 'LOCAL="two words"; printf "%s\\n" "$LOCAL"'],
  ["export", "export LOCAL=hello; printenv LOCAL"],
  ["command environment", "LOCAL=hello printenv LOCAL"],
  ["assignment expansion", 'LOCAL="$WORD"; printf "%s\\n" "$LOCAL"'],
  ["sequence", "printf a; printf b"],
  ["success", "true"],
  ["failure", "false"],
  ["and success", "true && printf yes"],
  ["and short circuit", "false && printf no"],
  ["or recovery", "false || printf yes"],
  ["or short circuit", "true || printf no"],
  ["and or chain", "false && printf no || printf yes"],
  ["pipe", "printf '%s\\n' hello | cat"],
  ["three stage pipe", "printf '%s\\n' hello | cat | cat"],
  ["pipeline last status", "false | true"],
  ["pipeline failure", "true | false"],
  ["if true", "if true; then printf yes; fi"],
  ["if else", "if false; then printf no; else printf yes; fi"],
  ["elif", "if false; then printf no; elif true; then printf yes; else printf no; fi"],
  ["test file", "test -f input.txt && printf yes"],
  ["bracket directory", "[ -d sub ] && printf yes"],
  ["bracket string", '[ "$WORD" = hello ] && printf yes'],
  ["bracket number", "[ 3 -gt 2 ] && printf yes"],
  ["substitution", "printf '%s\\n' $(printf hello)"],
  ["substitution whitespace", "printf '<%s>\\n' $(printf 'two words')"],
  ["quoted substitution", 'printf "<%s>\\n" "$(printf \'two words\')"'],
  ["substitution strips newlines", 'printf "<%s>\\n" "$(printf \'hello\\n\\n\')"'],
  ["nested substitution", 'printf "%s\\n" "$(printf \'%s\' "$(printf hello)")"'],
  ["backticks", "printf '%s\\n' `printf hello`"],
  ["quoted backticks", 'printf "<%s>\\n" "`printf \'two words\'`"'],
  ["stdout redirect", "printf hello > out; cat out"],
  ["stdout append", "printf hello >> out; cat out"],
  ["explicit stdout redirect", "printf hello 1> out; cat out"],
  ["stderr descriptor", "printf warning 1>&2"],
  ["merge stderr", "/bin/sh -c 'printf warning 1>&2' 2>&1"],
  ["stderr file", "printf hello 2> out; cat out"],
  ["stdin redirect", "cat < input.txt"],
  ["quoted glob", "printf '%s\\n' '*.txt'"],
  ["cd", "cd sub && cat nested.txt"],
  ["cd home", "cd sub; cd; cat input.txt"],
  ["subshell", "(printf a; printf b)"],
  ["subshell variable isolation", "LOCAL=outer; (LOCAL=inner); printf '%s\\n' $LOCAL"],
  ["echo words", "echo hello world"],
  ["echo quoted empty", "echo ''"],
  ["echo no newline", "echo -n hello"],
  ["printf interpreted argument", "printf '%b' 'a\\nb'"],
  ["printf octal escape", "printf '\\141'"],
  ["spaced continuation", "printf '<%s>\\n' a \\\n b"],
  ["quoted continuation", 'printf "%s\\n" "a\\\nb"'],
] as const;

const BASH_CASES = [
  ["combined redirect", "/bin/sh -c 'printf out; printf err 1>&2' &> out; cat out"],
  ["combined append", "/bin/sh -c 'printf out; printf err 1>&2' &>> out; cat out"],
  ["brace expansion", "printf '%s\\n' {a,b}"],
] as const;

const VALUE_DEPENDENT_DIVERGENCES = [
  // Bun preserves whitespace in an unquoted expansion rather than splitting fields.
  ["unquoted whitespace", "printf '<%s>\\n' $X", "<two words>\n", "<two>\n<words>\n"],
  // Bun does not expand a wildcard supplied by a variable value.
  ["variable wildcard", "printf '<%s>\\n' $PATTERN", "<*.txt>\n", "<a.txt>\n<b.txt>\n<input.txt>\n"],
  // Unquoted variable values also leave POSIX question-mark wildcards literal in Bun.
  ["variable question glob", "printf '<%s>\\n' $QUESTION", "<?.txt>\n", "<a.txt>\n<b.txt>\n"],
  // Bracket patterns supplied as variable values are not expanded by Bun.
  ["variable bracket glob", "printf '<%s>\\n' $BRACKET", "<[ab].txt>\n", "<a.txt>\n<b.txt>\n"],
] as const;

const DOCUMENTED_GLOB_DIVERGENCES = [
  // Bun treats the POSIX single-character wildcard as a literal question mark.
  ["question glob", "printf '%s\\n' ?.txt", "?.txt\n", "a.txt\nb.txt\n"],
  // Bun treats the POSIX bracket wildcard as literal text.
  ["character class glob", "printf '%s\\n' [ab].txt", "[ab].txt\n", "a.txt\nb.txt\n"],
] as const;

const ECHO_DIVERGENCES = [
  // Backslash interpretation by echo is implementation-defined in POSIX.
  ["echo backslash", 'echo "a\\nb"', "a\\nb\n", "a\nb\n"],
  // Bun recognizes -e, whereas dash's echo prints it as an argument.
  ["echo -e", "echo -e hello", "hello\n", "-e hello\n"],
] as const;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const hostPath = process.env.PATH ?? "/usr/bin:/bin";
// Keep only host directories containing the small set of external fixture commands.
const path = [
  ...new Set(
    ["cat", "printf", "printenv", "bash"].flatMap((command) => {
      const executable = Bun.which(command, { PATH: hostPath });
      return executable === null ? [] : [dirname(executable)];
    }),
  ),
].join(":");
const bash = Bun.which("bash", { PATH: path });
const hasSh = await Bun.file("/bin/sh").exists();
// Gate implementation-defined echo cases on the reference, never on Bun's behavior.
const shEchoProfile = hasSh
  ? Bun.spawn(["/bin/sh", "-c", 'echo "a\\nb"; echo -e hello'], {
      env: { PATH: path, LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  : null;
const echoProfile =
  shEchoProfile === null
    ? ""
    : (await Promise.all([new Response(shEchoProfile.stdout).text(), shEchoProfile.exited]))[0];

const compare = async (source: string, shell = "/bin/sh") => {
  expect(bunShellDialectIssues(source)).toEqual([]);
  const root = await mkdtemp(join(tmpdir(), "lando-bun-shell-differential-"));
  roots.push(root);
  await mkdir(join(root, "sub"));
  await Promise.all(
    Object.entries({
      "input.txt": "input\n",
      "a.txt": "alpha\n",
      "b.txt": "beta\n",
      "sub/nested.txt": "nested\n",
    }).map(([name, content]) => Bun.write(join(root, name), content)),
  );
  const fixedEnv = {
    PATH: path,
    LC_ALL: "C",
    HOME: root,
    WORD: "hello",
    X: "two words",
    EMPTY: "",
    PATTERN: "*.txt",
    QUESTION: "?.txt",
    BRACKET: "[ab].txt",
  };
  await Bun.write(join(root, "out"), "seed\n");
  const bun = await Bun.$`${{ raw: source }}`.cwd(root).env(fixedEnv).nothrow().quiet();
  // Both interpreters see the same cwd, environment, and initial append target.
  await Bun.write(join(root, "out"), "seed\n");
  const child = Bun.spawn([shell, "-c", source], {
    cwd: root,
    env: fixedEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return {
    bun: { exitCode: bun.exitCode, stdout: bun.stdout, stderr: bun.stderr },
    reference: { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) },
  };
};

const expectedOutput = (exitCode: number, stdout: string, stderr = "") => ({
  exitCode,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
});

describe.skipIf(!hasSh)("Bun Shell differential against accepted POSIX sh forms", () => {
  test.each(POSIX_CASES)("%s", async (_name, source) => {
    const { bun, reference } = await compare(source);
    expect(bun).toEqual(reference);
  });

  describe.skipIf(bash === null)("Bash forms Bun Shell shares", () => {
    test.each(BASH_CASES)("%s", async (_name, source) => {
      if (bash === null) throw new TypeError("Bash suite requires bash on PATH");
      const { bun, reference } = await compare(source, bash);
      expect(bun).toEqual(reference);
    });
  });

  test("star glob matches the same names as sh but in directory order", async () => {
    const { bun, reference } = await compare("printf '%s\\n' *.txt");
    const names = (stdout: Buffer) => stdout.toString().split("\n").filter((line) => line !== "");
    expect(bun.exitCode).toBe(reference.exitCode);
    expect(names(bun.stdout).toSorted()).toEqual(names(reference.stdout));
  });

  for (const [label, cases, enabled] of [
    ["known value-dependent divergences accepted by the checker", VALUE_DEPENDENT_DIVERGENCES, true],
    ["documented literal glob divergences accepted by the checker", DOCUMENTED_GLOB_DIVERGENCES, true],
    ["implementation-defined echo divergences", ECHO_DIVERGENCES, echoProfile === "a\nb\n-e hello\n"],
  ] as const)
    describe.skipIf(!enabled)(label, () => {
      test.each([...cases])("%s still differs", async (_name, source, bunStdout, shStdout) => {
        const { bun, reference } = await compare(source);
        expect(bun).toEqual(expectedOutput(0, bunStdout));
        expect(reference).toEqual(expectedOutput(0, shStdout));
        expect(bun).not.toEqual(reference);
      });
    });
});
