import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpCommand, loadCommand } from "../src/families.ts";

test("Mongo config pipe preserves arbitrary URI bytes independently of archive stdin/stdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "sql-mongo-transport-"));
  try {
    const mongosh = join(root, "mongosh");
    writeFileSync(
      mongosh,
      `#!${process.execPath}\nawait Bun.write(Bun.stdout, JSON.stringify({uri:process.env.MONGO_URI}));\n`,
    );
    chmodSync(mongosh, 0o700);
    const tool = `#!${process.execPath}
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(3, "utf8"));
const archive = process.argv.includes("--restore-test") ? await Bun.stdin.text() : "dump-archive";
await Bun.write(Bun.stdout, JSON.stringify({config, archive, argv:process.argv.slice(2)}));
`;
    for (const binary of ["mongodump", "mongorestore"]) {
      writeFileSync(join(root, binary), tool);
      chmodSync(join(root, binary), 0o700);
    }
    const uri = "mongodb://literal\"\\\n\t☃@host/db?value='quoted'";
    const creds = { user: "user", database: "db", port: 27017 };
    for (const [command, archive] of [
      [dumpCommand("mongodb", creds), "dump-archive"],
      [loadCommand("mongodb", creds), "archive-input\n\u0000tail"],
    ] as const) {
      const script = command[2];
      if (script === undefined) throw new Error("Missing wrapper");
      const restoring = archive !== "dump-archive";
      const argv = ["bash", "-c", `${script}${restoring ? " --restore-test" : ""}`];
      const child = Bun.spawn(argv, {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MONGO_URI: uri },
        stdin: new Blob([archive]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({ config: { uri }, archive });
      expect(JSON.parse(stdout).argv).toContain("--config=/dev/fd/3");
      expect(JSON.stringify(argv)).not.toContain(uri);
      expect(JSON.stringify(JSON.parse(stdout).argv)).not.toContain(uri);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
