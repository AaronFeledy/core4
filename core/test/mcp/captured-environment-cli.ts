import { createStdioRendererIO } from "@lando/renderer/io";
import { Schema } from "effect";
import { runCli } from "../../src/cli/index";

const env = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
  JSON.parse(process.argv[2] ?? "null"),
);
await runCli({
  argv: process.argv.slice(3),
  rootUrl: "",
  context: {
    cwd: process.cwd(),
    env,
    io: createStdioRendererIO(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
});
