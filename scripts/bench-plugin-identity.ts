import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginImplementationIdentity } from "@lando/engine/plugins/implementation-identity";

const run = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-identity-bench-"));
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => mkdir(join(root, `src-${index}`))));
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        writeFile(join(root, `src-${index % 10}`, `file-${index}.ts`), `export const value = ${index};\n`),
      ),
    );
    await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const pkg =
          index % 2 === 0
            ? join(root, "node_modules", `dependency-${index}`)
            : join(root, "node_modules", "@scope", `dependency-${index}`);
        await mkdir(pkg, { recursive: true });
        await writeFile(
          join(pkg, "package.json"),
          JSON.stringify({ name: `dependency-${index}`, version: "1.0.0" }),
        );
      }),
    );
    const samples: number[] = [];
    for (let index = 0; index < 51; index++) {
      const start = performance.now();
      await pluginImplementationIdentity(root);
      samples.push(performance.now() - start);
    }
    const first = samples.shift();
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        bun: Bun.version,
        files: 500,
        dependencies: 50,
        repetitions: samples.length,
        firstMs: first,
        p50Ms: samples[25],
        p95Ms: samples[47],
        meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await run();
