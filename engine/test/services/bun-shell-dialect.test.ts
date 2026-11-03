import { describe, expect, test } from "bun:test";

import {
  type BunShellDialectIssue,
  applyBunShellReplacements,
  bunShellDialectIssues,
  correctedBunShellText,
} from "../../src/services/bun-shell-dialect.ts";

const texts = (issues: ReadonlyArray<BunShellDialectIssue>): string[] => issues.map((i) => i.text);
const indexes = (issues: ReadonlyArray<BunShellDialectIssue>): number[] => issues.map((i) => i.index);

describe("bunShellDialectIssues: flagged constructs", () => {
  test.each([
    ["echo ${X}", "${X}", 5],
    ["echo ${DEPLOY_TOKEN}", "${DEPLOY_TOKEN}", 5],
    ["echo ${NAME:-d}", "${NAME:-d}", 5],
    ["echo ${a:b}", "${a:b}", 5],
    ["echo ${}", "${}", 5],
    ["false; echo $?", "$?", 12],
    ["echo $@", "$@", 5],
    ["echo $#", "$#", 5],
    ["echo $*", "$*", 5],
    ["echo $$", "$$", 5],
    ["echo $!", "$!", 5],
    ["echo $-", "$-", 5],
    ["echo $1", "$1", 5],
    ["echo $0", "$0", 5],
    ["echo $9", "$9", 5],
    ["echo hi >&2", ">&2", 8],
    ["echo hi <&0", "<&0", 8],
    ["echo hi 2>&-", "2>&-", 8],
    ["echo hi >& /tmp/x", ">&", 8],
    ["echo hi &>&2", "&>&2", 8],
    ["echo x >f 2>&1", "2>&1", 10],
    ["echo x >out.log 2>&1", "2>&1", 16],
    ["cmd 1>&2 2>/dev/null", "2>", 9],
    ["echo $((1+2))", "$((", 5],
    ["cat <<EOF", "<<", 4],
    ["echo <<<hi", "<<<", 5],
    ['echo "abc', '"', 5],
    ["echo 'abc", "'", 5],
    ["echo a#${X}", "${X}", 7],
    ['echo a"#"${X}', "${X}", 9],
    ['echo "${X}"', "${X}", 6],
    ['echo "$?"', "$?", 6],
  ] as const)("flags %s at the construct", (source, text, index) => {
    const issues = bunShellDialectIssues(source);
    expect(texts(issues)).toContain(text);
    const hit = issues.find((i) => i.text === text && i.index === index);
    expect(hit).toBeDefined();
    expect(hit?.message.length ?? 0).toBeGreaterThan(0);
    expect(hit?.suggestion.length ?? 0).toBeGreaterThan(0);
  });

  test("plain ${NAME} message names the construct and suggests $NAME", () => {
    const [issue] = bunShellDialectIssues("echo ${DEPLOY_TOKEN}");
    expect(issue?.text).toBe("${DEPLOY_TOKEN}");
    expect(issue?.message).toBe("Bun Shell does not expand ${DEPLOY_TOKEN}.");
    expect(issue?.suggestion).toBe(
      'Write $DEPLOY_TOKEN, or "$DEPLOY_TOKEN" when a letter, digit, or underscore follows it.',
    );
  });

  test("parameter expansion form gets the generic ${...} message", () => {
    const [issue] = bunShellDialectIssues("echo ${NAME:-default}");
    expect(issue?.message).toBe(
      "Bun Shell does not support ${...} parameter expansion such as ${NAME:-default}.",
    );
    expect(issue?.suggestion).toBe("Write $NAME and set a default through env:.");
  });

  test("$? suggests branching with && or ||", () => {
    const [issue] = bunShellDialectIssues("echo $?");
    expect(issue?.message).toBe("Bun Shell does not expand $?.");
    expect(issue?.suggestion).toBe("Branch on the exit status with && or || instead.");
  });

  test("$@ in reject mode points at forwarded arguments", () => {
    const [issue] = bunShellDialectIssues("echo $@");
    expect(issue?.message).toBe("Bun Shell does not expand $@.");
    expect(issue?.suggestion).toBe(
      "Remove it. Lando appends forwarded arguments to the end of a host command.",
    );
  });

  test("$@ in allow mode points at $1..$9 and declared input env vars", () => {
    const [issue] = bunShellDialectIssues("echo $@", { positional: "allow" });
    expect(issue?.message).toBe("Bun Shell does not expand $@.");
    expect(issue?.suggestion).toContain("LANDO_FLAG_");
    expect(issue?.suggestion).toContain("LANDO_ARG_");
    expect(issue?.suggestion).toContain("LANDO_INPUT");
    expect(issue?.suggestion).toContain("$1 through $9");
  });

  test("$$ suggests removal", () => {
    const [issue] = bunShellDialectIssues("echo $$");
    expect(issue?.message).toBe("Bun Shell does not expand $$.");
    expect(issue?.suggestion).toBe("Remove it.");
  });

  test("$1 in reject mode is not bound to forwarded arguments", () => {
    const [issue] = bunShellDialectIssues("echo $1");
    expect(issue?.text).toBe("$1");
    expect(issue?.message).toBe("$1 is not bound to forwarded arguments in a host command.");
    expect(issue?.suggestion).toBe(
      "Remove it. Lando appends forwarded arguments to the end of a host command.",
    );
  });

  test(">&2 asks for an explicit source descriptor", () => {
    const [issue] = bunShellDialectIssues("echo hi >&2");
    expect(issue?.text).toBe(">&2");
    expect(issue?.message).toBe("Bun Shell needs an explicit source descriptor in >&2.");
    expect(issue?.suggestion).toBe("Write 1>&2.");
  });

  test("<&0 suggests file or pipe input", () => {
    const [issue] = bunShellDialectIssues("echo hi <&0");
    expect(issue?.suggestion).toBe("Redirect input from a file with <file or a pipe.");
  });

  test("2>&- suggests discarding with 2>/dev/null", () => {
    const [issue] = bunShellDialectIssues("echo hi 2>&-");
    expect(issue?.suggestion).toBe("Discard the output with 2>/dev/null instead.");
  });

  test(">&file and &>&2 suggest &>file", () => {
    const a = bunShellDialectIssues("echo hi >& /tmp/x")[0];
    expect(a?.suggestion).toBe("Write &>file to send stdout and stderr to a file.");
    const b = bunShellDialectIssues("echo hi &>&2")[0];
    expect(b?.text).toBe("&>&2");
    expect(b?.suggestion).toBe("Write &>file to send stdout and stderr to a file.");
  });

  test("multiple redirections name the second operator", () => {
    const issues = bunShellDialectIssues("echo x >f 2>&1");
    const multi = issues.find((i) => i.message.includes("one redirection per command"));
    expect(multi?.text).toBe("2>&1");
    expect(multi?.message).toBe("Bun Shell accepts one redirection per command, and 2>&1 is a second one.");
    expect(multi?.suggestion).toContain("&>file");
  });

  test("$(( suggests bun -e arithmetic", () => {
    const [issue] = bunShellDialectIssues("echo $((1+2))");
    expect(issue?.text).toBe("$((");
    expect(issue?.message).toBe("Bun Shell has no $((...)) arithmetic.");
    expect(issue?.suggestion).toContain("bun -e");
  });

  test("here-documents and here-strings share one message", () => {
    for (const source of ["cat <<EOF", "echo <<<hi"] as const) {
      const [issue] = bunShellDialectIssues(source);
      expect(issue?.message).toBe("Bun Shell has no here-documents or here-strings.");
      expect(issue?.suggestion).toContain("printf");
    }
  });

  test("unterminated quotes report the opening quote character", () => {
    const dq = bunShellDialectIssues('echo "abc')[0];
    expect(dq?.text).toBe('"');
    expect(dq?.message).toBe('This " quote is never closed.');
    expect(dq?.suggestion).toBe("Close the quote.");
    const sq = bunShellDialectIssues("echo 'abc")[0];
    expect(sq?.text).toBe("'");
    expect(sq?.message).toBe("This ' quote is never closed.");
  });

  test("issues are reported in source order", () => {
    const issues = bunShellDialectIssues("echo ${A} $? ${B}");
    expect(indexes(issues)).toEqual([...indexes(issues)].sort((a, b) => a - b));
    expect(texts(issues)).toEqual(["${A}", "$?", "${B}"]);
  });
});

describe("bunShellDialectIssues: clean constructs", () => {
  test.each([
    ["echo $NAME"],
    ['echo "$NAME"'],
    ["echo '${X}'"],
    ["echo \\${X}"],
    ['echo "\\${X}"'],
    ["echo $(echo ok)"],
    ["echo `echo ok`"],
    ["echo hi 1>&2"],
    ["echo hi 2>&1"],
    ["echo hi &> /tmp/x"],
    ["echo hi &>> /tmp/x"],
    ["echo hi 2>>/tmp/x"],
    ["cat </dev/null"],
    ["echo a > /tmp/x"],
    ["echo {a,b}"],
    ["echo ~"],
    ['echo "a" #${X}'],
    ["X=1; echo $X"],
    ["echo $(echo a 2>&1) 2>/dev/null"],
    ["echo a >f && echo b 2>&1"],
    ["false || echo b 2>&1"],
    ["echo a >f | cat"],
    ["echo a; echo b 2>&1"],
    ["echo $NAME$OTHER"],
    ["echo pre$NAME"],
  ] as const)("does not flag %s", (source) => {
    expect(bunShellDialectIssues(source)).toEqual([]);
  });

  test("line continuation with backslash-newline stays clean", () => {
    expect(bunShellDialectIssues("echo $X\\\ny")).toEqual([]);
  });
});

describe("bunShellDialectIssues: quotes, escapes, comments, nesting", () => {
  test("single-quoted ${X} is not a braced expansion", () => {
    expect(bunShellDialectIssues("echo '${X}'")).toEqual([]);
  });

  test("backslash escapes $ outside and inside double quotes", () => {
    expect(bunShellDialectIssues("echo \\${X}")).toEqual([]);
    expect(bunShellDialectIssues('echo "\\${X}"')).toEqual([]);
    expect(bunShellDialectIssues("echo \\$?")).toEqual([]);
  });

  test("comment at word start hides braced forms through end of line", () => {
    expect(bunShellDialectIssues('echo "a" #${X} $?')).toEqual([]);
    expect(bunShellDialectIssues("# ${X}\necho ok")).toEqual([]);
  });

  test("hash inside a word is not a comment", () => {
    const issues = bunShellDialectIssues("echo a#${X}");
    expect(texts(issues)).toEqual(["${X}"]);
  });

  test("hash inside quotes is not a comment starter after the word", () => {
    const issues = bunShellDialectIssues('echo a"#"${X}');
    expect(texts(issues)).toEqual(["${X}"]);
  });

  test("nested $(...) keeps its own redirection counter", () => {
    expect(bunShellDialectIssues("echo $(echo a 2>&1) 2>/dev/null")).toEqual([]);
    const nested = bunShellDialectIssues("echo $(echo a >f 2>&1)");
    expect(nested.some((i) => i.message.includes("one redirection per command"))).toBe(true);
  });

  test("backtick nesting keeps its own redirection counter", () => {
    expect(bunShellDialectIssues("echo `echo a 2>&1` 2>/dev/null")).toEqual([]);
  });

  test("double-quoted command substitution still scans the inner unquoted body", () => {
    const issues = bunShellDialectIssues('echo "$(echo ${X})"');
    expect(texts(issues)).toEqual(["${X}"]);
  });

  test("&& || | ; and newline reset the simple-command redir counter", () => {
    expect(bunShellDialectIssues("echo a >f && echo b 2>&1")).toEqual([]);
    expect(bunShellDialectIssues("echo a >f || echo b 2>&1")).toEqual([]);
    expect(bunShellDialectIssues("echo a >f | echo b 2>&1")).toEqual([]);
    expect(bunShellDialectIssues("echo a >f; echo b 2>&1")).toEqual([]);
    expect(bunShellDialectIssues("echo a >f\necho b 2>&1")).toEqual([]);
  });

  test("second redirection after a reset is not multi across commands", () => {
    const issues = bunShellDialectIssues("echo a >f; echo b >g 2>&1");
    expect(issues.some((i) => i.message.includes("one redirection"))).toBe(true);
    expect(issues.some((i) => i.text === "2>&1")).toBe(true);
  });
});

describe("bunShellDialectIssues: positional reject vs allow", () => {
  test("reject (default) flags $0 through $9", () => {
    for (const n of ["0", "1", "5", "9"] as const) {
      const issues = bunShellDialectIssues(`echo $${n}`);
      expect(texts(issues)).toContain(`$${n}`);
    }
  });

  test("allow leaves $0 through $9 clean but still flags $@ $# $*", () => {
    for (const n of ["0", "1", "9"] as const) {
      expect(bunShellDialectIssues(`echo $${n}`, { positional: "allow" })).toEqual([]);
    }
    expect(texts(bunShellDialectIssues("echo $@", { positional: "allow" }))).toEqual(["$@"]);
    expect(texts(bunShellDialectIssues("echo $#", { positional: "allow" }))).toEqual(["$#"]);
    expect(texts(bunShellDialectIssues("echo $*", { positional: "allow" }))).toEqual(["$*"]);
  });

  test("$10 is $1 followed by literal 0 under reject", () => {
    const issues = bunShellDialectIssues("echo $10");
    expect(texts(issues)).toEqual(["$1"]);
  });
});

describe("bunShellDialectIssues: descriptor duplication and comments follow Bun Shell", () => {
  test.each([
    ["echo x 3>&1", "3>&1"],
    ["echo x 1>&3", "1>&3"],
    ["echo x 2>&10", "2>&10"],
    ["echo x 0<&0", "0<&0"],
    ["echo x 2<&1", "2<&1"],
    ["echo x;#${X}", "${X}"],
  ] as const)("flags %s", (source, text) => {
    expect(texts(bunShellDialectIssues(source))).toEqual([text]);
  });

  test.each([["echo x 2>>&1"], ["echo x 1>>&2"], ["echo x2>&1"], ["# note ${X}\necho ok"]] as const)(
    "does not flag %s",
    (source) => {
      expect(bunShellDialectIssues(source)).toEqual([]);
    },
  );

  test("suggests the matching duplication for a missing source descriptor", () => {
    expect(bunShellDialectIssues("echo x >&2")[0]?.suggestion).toBe("Write 1>&2.");
    expect(bunShellDialectIssues("echo x >&1")[0]?.suggestion).toBe("Remove it; it points stdout at itself.");
  });
});

describe("correctedBunShellText", () => {
  test.each([
    ["echo ${HOME} >&2", "echo $HOME 1>&2"],
    ['printf "%s" "${TOKEN}" | wc -c', 'printf "%s" "$TOKEN" | wc -c'],
  ] as const)("fixes %s mechanically", (source, corrected) => {
    expect(correctedBunShellText(source)).toBe(corrected);
  });

  test.each([
    ["echo ok", "nothing to fix"],
    ["echo ${A}b", "the braces end before a name character"],
    ["false; echo $?", "the fix needs a decision"],
    ["echo ${HOME} >f 2>&1", "one issue has no mechanical fix"],
  ] as const)("offers nothing for %s because %s", (source) => {
    expect(correctedBunShellText(source)).toBeUndefined();
  });

  test("applies replacements at their offsets without touching other text", () => {
    const source = "echo ${secret:KEY} ${HOME}";
    const issues = bunShellDialectIssues(`echo ${"_".repeat(13)} \${HOME}`);
    expect(applyBunShellReplacements(source, issues)).toBe("echo ${secret:KEY} $HOME");
  });
});
