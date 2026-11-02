import { parseArgs } from "node:util";
import { runStorageLifecycle } from "@lando/container-runtime/testing/storage-lifecycle";
import { Schema } from "effect";

const input = Schema.Struct({
  provider: Schema.Literals(["docker", "podman"]),
  socket: Schema.String.check(Schema.isMinLength(1)),
});

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      provider: { type: "string" },
      socket: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = Schema.decodeUnknownSync(input)(values);
  console.log(JSON.stringify(await runStorageLifecycle(options)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({ outcome: "failed", error: error instanceof Error ? error.stack : String(error) }),
    );
    process.exitCode = 1;
  });
}
