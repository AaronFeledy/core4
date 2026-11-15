import { createStdioRendererIO } from "@lando/renderer/io";
import { runCli } from "../../src/cli/index";

const cwd = process.argv[2];
if (cwd === undefined) throw new TypeError("Missing invocation directory");
await runCli({
  argv: process.argv.slice(3),
  rootUrl: "",
  context: {
    cwd,
    env: { ...process.env },
    io: createStdioRendererIO(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  },
});
