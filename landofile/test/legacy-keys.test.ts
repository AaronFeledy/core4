import { expect, test } from "bun:test";
import { hasLegacyRawKeys } from "../src/legacy-keys.ts";

test.each([
  "services:\n  web:\n    environment:\n      overrides: yes\n",
  "services:\n  web:\n    image: alpine\n      overrides: yes\n",
  "x-note: |\n  recipe: lamp\n  config: {}\n",
  "recipe: lamp\n",
  "services:\n  web:\n    type: php:8.3\n    api: 4\n",
])("ignores keys outside legacy mapping positions (%#)", (content) => {
  // Given / When
  const result = hasLegacyRawKeys(content);
  // Then
  expect(result).toBe(false);
});

test.each(["run_as_root", "build_internal", "run_internal", "build_as_root", "overrides", "portforward"])(
  "recognizes the service key %s",
  (key) => {
    // Given
    const content = `services:\n  web:\n    ${key}: []\n`;
    // When
    const result = hasLegacyRawKeys(content);
    // Then
    expect(result).toBe(true);
  },
);

test("ignores a key whose scalar is truncated at the byte cap", () => {
  // Given
  const start = "services:\n  web:\n";
  const end = "    api: 30\n";
  const content = `${start}#${"x".repeat(1024 * 1024 - start.length - end.length)}\n${end}`;
  // When
  const result = hasLegacyRawKeys(content);
  // Then
  expect(result).toBe(false);
});
