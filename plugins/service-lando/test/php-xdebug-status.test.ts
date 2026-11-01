import { expect, test } from "bun:test";
import { phpXdebugTooling } from "../src/services/php-xdebug.ts";

for (const address of ["172.27.48.1", "2001:db8::40", undefined]) {
  test(`status reads effective PHP settings with ${address ?? "unresolved host"}`, async () => {
    // Given
    const task = phpXdebugTooling("php", "cli", "debug").xdebug;
    const command = task?.cmd;
    if (!Array.isArray(command) || typeof command[2] !== "string")
      throw new TypeError("Missing tooling script");
    const php = `php() {
      case "$2" in
        *xdebug.client_host*) printf '%s' 'custom-ide.internal' ;;
        *xdebug.client_port*) printf '%s' '9010' ;;
        *) printf 'Xdebug enabled (debug)\\n' ;;
      esac
    }`;
    const getent = `getent() {
      [ "$1" = hosts ] && [ "$2" = custom-ide.internal ] || return 1
      ${address === undefined ? "return 2" : `printf '%s custom-ide.internal\\n' '${address}'`}
    }`;
    // When
    const child = Bun.spawn(["sh", "-c", `${php}\n${getent}\n${command[2]}`, "xdebug", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    // Then
    expect(await child.exited).toBe(0);
    expect(output).toBe(
      `Xdebug enabled (debug)\nClient: custom-ide.internal:9010${address === undefined ? "" : ` (${address})`}\n`,
    );
  });
}
