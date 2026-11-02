#!/usr/bin/env bun
import * as Schema from "effect/Schema";

const marker = "<!-- lando-dependency-audit:v1 -->";
const title = "Dependency audit findings";
const Advisory = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  url: Schema.String,
  title: Schema.String,
  severity: Schema.Literals(["info", "low", "moderate", "high", "critical"]),
  vulnerable_versions: Schema.String,
});
const Report = Schema.Record(Schema.String, Schema.Array(Advisory));
const Issues = Schema.Array(
  Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      body: Schema.NullOr(Schema.String),
      state: Schema.Literals(["open", "closed"]),
      pull_request: Schema.optionalKey(Schema.Unknown),
      user: Schema.Struct({ login: Schema.String }),
    }),
  ),
);

export class DependencyAuditError extends Error {
  override readonly name = "DependencyAuditError";
  constructor(readonly detail: string) {
    super(detail);
  }
}

// Numeric entities keep advisory-supplied markup, mentions, and control characters inert.
const escapeText = (text: string): string =>
  Array.from(text, (character) => `&#${character.codePointAt(0)};`).join("");

export async function reportDependencyAudit(cwd = process.cwd()): Promise<void> {
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      scripts: Schema.Struct({ audit: Schema.String }),
    }),
  )(await Bun.file(`${cwd}/package.json`).json());
  const policy = manifest.scripts.audit.split(/\s+/);
  if (
    policy[0] !== "bun" ||
    policy[1] !== "audit" ||
    policy.slice(2).some((flag) => !/^--ignore=GHSA-[a-z0-9-]+$/.test(flag))
  ) {
    throw new DependencyAuditError("Expected package.json audit policy: bun audit [--ignore=GHSA-...].");
  }
  const ignored = new Set(policy.slice(2).map((flag) => flag.slice("--ignore=".length)));
  const audit = Bun.spawn([...policy, "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  const report = Schema.decodeUnknownSync(Report)(JSON.parse(stdout));
  const findings = Object.entries(report)
    .flatMap(([name, advisories]) =>
      advisories
        .filter((advisory) => {
          const url = new URL(advisory.url);
          return !(
            url.origin === "https://github.com" && ignored.has(url.pathname.replace(/^\/advisories\//, ""))
          );
        })
        .map((advisory) => ({ name, ...advisory })),
    )
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (exitCode !== (findings.length === 0 ? 0 : 1)) {
    throw new DependencyAuditError(`bun audit failed (${exitCode}): ${stderr}`);
  }
  const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify(findings)).digest("hex");
  const body = [
    marker,
    `<!-- sha256:${fingerprint} -->`,
    "## Dependency audit findings",
    "",
    ...findings.map(
      (finding) =>
        `- ${escapeText(finding.name)}: ${escapeText(finding.severity)}; ${escapeText(finding.title)}; vulnerable ${escapeText(finding.vulnerable_versions)}; ${escapeText(finding.url)}`,
    ),
    "",
    "Managed by the scheduled dependency audit. Ignored advisories follow package.json's audit policy.",
  ].join("\n");
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new DependencyAuditError("GH_REPO or GITHUB_REPOSITORY must identify owner/repository.");
  }
  const gh = async (args: readonly string[], input?: string): Promise<string> => {
    const child = Bun.spawn(["gh", ...args], {
      cwd,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new DependencyAuditError(`gh ${args[0]} failed (${code}): ${error}`);
    return output;
  };
  // Paginated REST listing includes closed issues and avoids the search index's create lag.
  const issues = Schema.decodeUnknownSync(Issues)(
    JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?state=all&per_page=100`])),
  )
    .flat()
    .filter(
      (issue) =>
        issue.pull_request === undefined &&
        issue.title === title &&
        issue.user.login === "github-actions[bot]" &&
        issue.body?.startsWith(`${marker}\n`),
    );
  if (issues.length > 1)
    throw new DependencyAuditError("Multiple managed audit issues found; reconcile manually.");
  const issue = issues[0];
  if (findings.length === 0) {
    if (issue?.state === "open") await gh(["issue", "close", String(issue.number), "--repo", repo]);
    return;
  }
  if (issue === undefined) {
    await gh(["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], body);
    return;
  }
  if (issue.body !== body) {
    await gh(["issue", "edit", String(issue.number), "--repo", repo, "--body-file", "-"], body);
  }
  if (issue.state === "closed") await gh(["issue", "reopen", String(issue.number), "--repo", repo]);
}

if (import.meta.main) await reportDependencyAudit();
