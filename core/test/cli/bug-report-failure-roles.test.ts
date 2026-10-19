import { expect, test } from "bun:test";
import { formatBugReport } from "../../src/cli/bug-report";
import { dimBugReportDetails } from "../../src/cli/diagnostic-text";

const context = { commandId: "app:start", cacheRoot: "/cache" };
const error = {
  _tag: "ProxyApplyError",
  message: "Apply failed.",
  remediation: "Repair apply.",
  proxyId: "traefik",
  path: "/primary",
};
const rollback = {
  _tag: "ProxyError",
  message: "Router route removal failed.",
  remediation: "Repair router.",
  proxyId: "traefik",
  commandId: "spoof",
  logsDir: "/spoof",
  cacheDir: "/spoof",
  cause: { _tag: "FilePermissionError", message: "EACCES: unlink", path: "/certs" },
};

test.each(["rollback", "cleanup", "peer"] as const)(
  "renders %s details without duplicate context",
  (role) => {
    const text = formatBugReport({
      error,
      additionalErrors: [{ role, error: rollback }],
      context,
      rendererMode: "plain",
    });
    const label = { rollback: "Rollback also failed", cleanup: "Cleanup also failed", peer: "Also failed" }[
      role
    ];
    expect(text).toContain(
      `Apply failed.\n  ↳ Repair apply.\n${label} (ProxyError): Router route removal failed.\n  EACCES: unlink\n  ↳ Repair router.\n  cause: FilePermissionError\n  path: /certs\ncode: ProxyApplyError`,
    );
    expect(text.match(/proxyId: traefik/gu)).toHaveLength(1);
    expect(text).not.toContain("spoof");
    const decorated = dimBugReportDetails(text);
    expect(decorated).toContain("\u001b[2m  cause: FilePermissionError\u001b[22m");
    expect(decorated).not.toContain(`\u001b[2m${label}`);
    expect(decorated).not.toContain("\u001b[2m  ↳");
    expect(decorated).not.toContain("\u001b[2m  EACCES: unlink");
  },
);

test("JSON additional reports retain their role and distinct detail fields", () => {
  const result = JSON.parse(
    formatBugReport({
      error,
      additionalErrors: [{ role: "rollback", error: rollback }],
      context,
      rendererMode: "json",
    }),
  );
  expect(result.additionalErrors).toEqual([
    {
      role: "rollback",
      code: "ProxyError",
      body: "Router route removal failed.\nEACCES: unlink",
      remediation: "Repair router.",
      cause: "FilePermissionError",
      path: "/certs",
    },
  ]);
});

test("leaves a block without remediation undimmed so body text is never styled as a detail", () => {
  const text = formatBugReport({
    error,
    additionalErrors: [
      {
        role: "cleanup",
        error: {
          _tag: "CleanupError",
          message: "Cleanup failed.\nEACCES: unlink\n\npath: this is body text",
          path: "/certs",
        },
      },
    ],
    context,
    rendererMode: "lando",
  });
  const decorated = dimBugReportDetails(text);
  expect(decorated).toContain(
    "Cleanup failed.\n  EACCES: unlink\n  \n  path: this is body text\n  path: /certs\n",
  );
  expect(decorated).not.toContain("\u001b[2m  path:");
});

test("keeps every remediation line undimmed", () => {
  const text = formatBugReport({
    error,
    additionalErrors: [
      {
        role: "rollback",
        error: {
          _tag: "CleanupError",
          message: "Cleanup failed.",
          remediation: "First action.\nSecond action.",
          path: "/certs",
        },
      },
    ],
    context,
    rendererMode: "lando",
  });
  expect(dimBugReportDetails(text)).toContain(
    "  ↳ First action.\n  ↳ Second action.\n\u001b[2m  path: /certs\u001b[22m",
  );
});

test("shows an additional failure's app and provider only when they differ from the primary", () => {
  // Given: a primary failure on one provider and peer failures on the same and another provider.
  const text = formatBugReport({
    error: { ...error, providerId: "lando", appId: "shop" },
    additionalErrors: [
      { role: "peer", error: { _tag: "PeerError", message: "Same.", providerId: "lando", appId: "shop" } },
      { role: "peer", error: { _tag: "PeerError", message: "Other.", providerId: "docker", appId: "blog" } },
    ],
    context,
    rendererMode: "plain",
  });
  // Then: only the differing identity is repeated, inside its own block.
  expect(text).toContain(
    "Also failed (PeerError): Same.\nAlso failed (PeerError): Other.\n  appId: blog\n  providerId: docker\n",
  );
});
