import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

const AUTHOR_MODULE = `
import { LandofileValidationError } from "@lando/sdk/errors";
export const authoredFailure = () =>
  new LandofileValidationError({ message: "authored failure", remediation: "Fix the service.", file: "/app/.lando.yml", issues: [] });
`;

const childScript = (authorPath: string): string => `
const loadEngine = () => import(${JSON.stringify(join(repoRoot, "engine/src/planner/service-errors.ts"))});
const loadAuthor = async () => {
  const { importAuthorModule } = await import(${JSON.stringify(join(repoRoot, "landofile/src/author-modules.ts"))});
  return importAuthorModule(${JSON.stringify(authorPath)});
};
const engineFirst = process.argv[2] === "engine-first";
const engine = engineFirst ? await loadEngine() : undefined;
const author = await loadAuthor();
const { servicePlanError } = engine ?? (await loadEngine());
const cause = author.authoredFailure();
const planned = servicePlanError({ appRoot: "/app", serviceName: "web", cause });
console.log(JSON.stringify({ tag: cause._tag, recognized: planned === cause }));
`;

// Each order needs a fresh process: inside one test process, whichever file loaded the SDK first
// decides the order. Registering author modules must not give engine code a second SDK copy (#2382).
for (const order of ["engine-first", "author-first"] as const) {
  test(`engine recognizes an SDK error thrown by an author module when it loads ${order}`, async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "lando-author-identity-"));
    try {
      const authorPath = join(directory, "author.ts");
      const scriptPath = join(directory, "child.ts");
      await Bun.write(authorPath, AUTHOR_MODULE);
      await Bun.write(scriptPath, childScript(authorPath));

      // When
      const child = Bun.spawn([process.execPath, scriptPath, order], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      // Then
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ tag: "LandofileValidationError", recognized: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
