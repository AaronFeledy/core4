import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Schema from "effect/Schema";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const advisory = {
  id: 1,
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  title: "bad </li> @everyone `$(touch injected)`",
  severity: "high",
  vulnerable_versions: "<2.0.0",
};
const Call = Schema.Struct({ args: Schema.Array(Schema.String), body: Schema.String });
const callsSchema = Schema.Array(Call);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dependency-audit-"));
  roots.push(root);
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { audit: "bun audit --ignore=GHSA-ch52-4w7c-c8xp" },
    }),
  );
  const fake = `#!${process.execPath}
const root = process.env.AUDIT_FIXTURE;
if (process.argv[1].endsWith('/bun')) {
  process.stdout.write(await Bun.file(root + '/audit.json').text());
  process.exit(Number(process.env.AUDIT_EXIT));
}
const args = process.argv.slice(2);
const body = await new Response(Bun.stdin.stream()).text();
const file = Bun.file(root + '/calls.jsonl');
await Bun.write(file, (await file.text()) + JSON.stringify({ args, body }) + '\\n');
if (args[0] === 'api') process.stdout.write(await Bun.file(root + '/issues.json').text());
`;
  for (const name of ["bun", "gh"]) {
    await Bun.write(join(root, name), fake);
    await chmod(join(root, name), 0o755);
  }
  const run = async (report: unknown, issues: readonly unknown[] = [], exit = 1) => {
    await Bun.write(join(root, "audit.json"), typeof report === "string" ? report : JSON.stringify(report));
    await Bun.write(join(root, "issues.json"), JSON.stringify([issues]));
    await Bun.write(join(root, "calls.jsonl"), "");
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dirname, "../../../scripts/dependency-audit.ts")],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          GH_REPO: "owner/repo",
          AUDIT_FIXTURE: root,
          AUDIT_EXIT: String(exit),
        },
      },
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const lines = (await Bun.file(join(root, "calls.jsonl")).text()).trim();
    const calls = Schema.decodeUnknownSync(callsSchema)(
      lines ? lines.split("\n").map((line) => JSON.parse(line)) : [],
    );
    return { code, error, writes: calls.filter((call) => call.args[0] === "issue"), calls };
  };
  const initial = await run({ example: [advisory] });
  expect(initial.code).toBe(0);
  const body = initial.writes[0]?.body;
  if (body === undefined) throw new TypeError("Missing initial issue body");
  const issue = {
    number: 42,
    title: "Dependency audit findings",
    body,
    state: "open",
    user: { login: "github-actions[bot]" },
  };
  return { run, issue, initial };
}

test("creates an issue with inert advisory content through gh stdin", async () => {
  const { initial } = await fixture();
  expect(initial.writes.map((call) => call.args.slice(0, 2))).toEqual([["issue", "create"]]);
  expect(initial.writes[0]?.args).toContain("--body-file");
  expect(initial.writes[0]?.body).not.toContain("@everyone");
  expect(initial.writes[0]?.body).not.toContain("</li>");
});

test("makes no write when findings are unchanged", async () => {
  const { run, issue } = await fixture();
  const result = await run({ example: [advisory] }, [issue]);
  expect(result.code).toBe(0);
  expect(result.writes).toEqual([]);
});

test("updates the same issue when findings change", async () => {
  const { run, issue } = await fixture();
  const result = await run({ example: [{ ...advisory, vulnerable_versions: "<3" }] }, [issue]);
  expect(result.code).toBe(0);
  expect(result.writes.map((call) => call.args.slice(0, 3))).toEqual([["issue", "edit", "42"]]);
  expect(result.writes[0]?.body).not.toBe(issue.body);
});

test("closes the open issue on a valid clean report", async () => {
  const { run, issue } = await fixture();
  const result = await run({}, [issue], 0);
  expect(result.code).toBe(0);
  expect(result.writes.map((call) => call.args.slice(0, 3))).toEqual([["issue", "close", "42"]]);
});

test("reopens the same closed issue when findings recur", async () => {
  const { run, issue } = await fixture();
  const result = await run({ example: [advisory] }, [{ ...issue, state: "closed" }]);
  expect(result.code).toBe(0);
  expect(result.writes.map((call) => call.args.slice(0, 3))).toEqual([["issue", "reopen", "42"]]);
});

test("does not create an issue on the first clean report", async () => {
  const { run } = await fixture();
  expect((await run({}, [], 0)).writes).toEqual([]);
});

for (const report of [
  "transport failure",
  "null",
  "[]",
  '{"error":"registry unavailable"}',
  "{}",
  '{"pkg":[{}]}',
]) {
  test(`fails without touching GitHub for invalid audit result ${report}`, async () => {
    const { run, issue } = await fixture();
    const result = await run(report, [issue]);
    expect(result.code).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
}

test("filters ignored GHSA before rendering and fingerprinting", async () => {
  const { run, issue } = await fixture();
  const ignored = { ...advisory, url: "https://github.com/advisories/GHSA-ch52-4w7c-c8xp" };
  const result = await run({ example: [advisory, ignored] }, [issue]);
  expect(result.code).toBe(0);
  expect(result.writes).toEqual([]);
});

test("treats an ignored-only report as clean", async () => {
  const { run, issue } = await fixture();
  const result = await run(
    { example: [{ ...advisory, url: "https://github.com/advisories/GHSA-ch52-4w7c-c8xp" }] },
    [issue],
    0,
  );
  expect(result.code).toBe(0);
  expect(result.writes[0]?.args.slice(0, 3)).toEqual(["issue", "close", "42"]);
});

test("does not resolve an issue when ignored-only output accompanies an audit failure", async () => {
  const { run, issue } = await fixture();
  const result = await run(
    { example: [{ ...advisory, url: "https://github.com/advisories/GHSA-ch52-4w7c-c8xp" }] },
    [issue],
    1,
  );
  expect(result.code).not.toBe(0);
  expect(result.calls).toEqual([]);
});

test("keeps fingerprint stable across package and advisory order", async () => {
  const { run } = await fixture();
  const second = { ...advisory, id: 2 };
  const first = await run({ z: [advisory], a: [advisory, second] });
  const issue = {
    number: 42,
    title: "Dependency audit findings",
    body: first.writes[0]?.body,
    state: "open",
    user: { login: "github-actions[bot]" },
  };
  const result = await run({ a: [second, advisory], z: [advisory] }, [issue]);
  expect(result.code).toBe(0);
  expect(result.writes).toEqual([]);
});

test("never edits unrelated issues or pull requests", async () => {
  const { run, issue } = await fixture();
  const result = await run({ example: [advisory] }, [
    { ...issue, body: "unrelated" },
    { ...issue, number: 43, user: { login: "person" } },
    { ...issue, number: 44, pull_request: {} },
  ]);
  expect(result.code).toBe(0);
  expect(result.writes.map((call) => call.args.slice(0, 2))).toEqual([["issue", "create"]]);
});
