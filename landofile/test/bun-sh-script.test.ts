import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveBunShellScript } from "../src/bun-sh-script.ts";

test("one-script lookup ignores unrelated malformed scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-one-script-"));
  try {
    await mkdir(join(root, ".lando/scripts/ops"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/ops/probe.bun.sh"),
      "# ---\n# summary: Probe\n# ---\necho ok\n",
    );
    await writeFile(
      join(root, ".lando/scripts/unrelated.bun.sh"),
      "# ---\n# flags: unsupported\n# ---\necho no\n",
    );
    const script = await Effect.runPromise(resolveBunShellScript(root, "ops:probe"));
    expect(script).toMatchObject({
      id: "app:ops:probe",
      relativePath: "ops/probe.bun.sh",
      service: ":host",
      summary: "Probe",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
