/**
 * Landofile Effect Schema.
 *
 * The canonical schema lives in `@lando/sdk/schema` (`LandofileShape`).
 * Top-level keys explicitly forbidden:
 *   - `compose:` (provider-specific)
 *   - `recipes:` (singular `recipe:` only)
 *
 * The forbidden-key check runs against the parsed YAML *before* schema
 * validation, so we get a meaningful error message instead of an opaque
 * "unknown key" rejection.
 */
export { LandofileShape } from "@lando/sdk/schema";
