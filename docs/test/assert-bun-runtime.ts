import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function assertBunRuntime(options: {
  version: string;
  executable: string;
  requireNodeFree?: boolean;
  resolveExecutable?: (name: string) => string | null;
}) {
  if (process.versions.bun !== options.version) throw new Error("Unexpected Bun runtime");
  if (!(options.requireNodeFree ?? process.env.DOCS_TEST_REQUIRE_NO_NODE === "1")) return;
  const resolveExecutable = options.resolveExecutable ?? ((name: string) => Bun.which(name));
  const sha256 = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const expectedHash = await sha256(options.executable);
  const verified = new Set<string>();
  for (const name of ["node", "node.exe"]) {
    const alias = resolveExecutable(name);
    if (!alias || verified.has(alias)) continue;
    if (!basename(dirname(alias)).startsWith("bun-node-")) throw new Error(`Unverified Node alias: ${alias}`);
    const hash = await sha256(alias);
    if (hash !== expectedHash) throw new Error(`Node executable differs from Bun: ${alias}`);
    const probe = Bun.spawn(
      [alias, "-e", "process.stdout.write(JSON.stringify({bun:process.versions.bun}))"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0 || JSON.parse(stdout).bun !== options.version)
      throw new Error(`Node alias is not the expected Bun runtime: ${alias} ${stderr}`);
    if (process.env.DOCS_BUN_ALIAS_RECEIPT)
      await appendFile(
        process.env.DOCS_BUN_ALIAS_RECEIPT,
        `${JSON.stringify({ alias, sha256: hash, expectedHash, bun: options.version })}\n`,
      );
    verified.add(alias);
  }
}
