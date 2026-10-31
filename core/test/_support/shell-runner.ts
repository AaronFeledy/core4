import * as Process from "@lando/engine/services/process-runner";
import * as Shell from "@lando/engine/services/shell-runner";
import type { ShellReplIO } from "@lando/sdk/services";
import { Layer } from "effect";

export const layer = (io: () => ShellReplIO) => Shell.layer(io).pipe(Layer.provide(Process.layer));
