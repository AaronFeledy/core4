/**
 * `PrivilegeService` — sudo/UAC adapter.
 *
 * Platform-specific Live Layer:
 *   - macOS / Linux → `sudo` (with `SUDO_ASKPASS` when an askpass helper is
 *     available)
 *   - Windows → UAC dispatch (`runas`)
 *
 * Replaceable to support `polkit`, `doas`, custom credential prompts.
 *
 * Status: stub.
 */
export { PrivilegeService } from "@lando/sdk/services";
