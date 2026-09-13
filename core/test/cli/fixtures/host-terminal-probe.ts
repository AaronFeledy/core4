import { attachedHostTerminal } from "../../../src/cli/exec-host-io.ts";

console.log(JSON.stringify(attachedHostTerminal() ?? null));
