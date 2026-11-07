import type { ShellReplIO } from "@lando/sdk/services";
import { Layer } from "effect";
import * as Process from "../src/services/process-runner.ts";
import * as Shell from "../src/services/shell-runner.ts";
export { withShellRedactionTokens } from "../src/services/shell-runner.ts";

export const layer = (io: () => ShellReplIO) => Shell.layer(io).pipe(Layer.provide(Process.layer));
export const layerWithPrivateFileAccess = (io: () => ShellReplIO) =>
  Shell.layerWithPrivateFileAccess(io).pipe(Layer.provide(Process.layer));
