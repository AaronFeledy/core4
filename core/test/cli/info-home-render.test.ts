import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import type { ServiceHomePlan } from "@lando/sdk/schema";
import { buildInfoSummary, renderInfoAppResult } from "../../src/cli/commands/info-render.ts";
import { decorated, planned, result, service } from "./info-storage-fixtures.ts";

test("labels only the retained home target as home in summary and TSV", () => {
  // Given a persisted home alongside another retained store.
  const info = result(
    service(
      "web",
      [
        planned({ type: "volume", target: "/root", source: "home-volume", lifetime: "retained" }),
        planned({ type: "volume", target: "/data", source: "data-volume", lifetime: "retained" }),
      ],
      { home: { state: "persisted", target: "/root", store: "home-volume" } },
    ),
  );
  // When rendering both human surfaces.
  const summary = stripAnsi(renderInfoAppResult(info, decorated(160)));
  const plain = renderInfoAppResult(info);
  // Then the home mount carries the home kind without a redundant home field.
  expect(summary).toContain("/root (home), /data (store)");
  expect(plain).toContain("web\tmount\t/root\thome\thome-volume\tretained");
  expect(plain).toContain("web\tmount\t/data\tstore\tdata-volume\tretained");
  expect(
    buildInfoSummary(info).sections[0]?.rows[0]?.fields?.filter((field) => field.label === "home"),
  ).toEqual([]);
});

test.each([
  ["custom-image", undefined, "image comes from your Landofile"],
  ["no-identity", undefined, "node doesn't declare image users"],
  ["undeclared-user", "alice", "node doesn't know where alice's home is"],
] as const)("explains unknown home once for %s on every human surface", (reason, user, explanation) => {
  // Given an unknown home, possibly with a declared principal.
  const home: ServiceHomePlan = { state: "unknown", reason, ...(user === undefined ? {} : { user }) };
  const info = result(service("web", [], { type: "node", home }));
  // When rendering summary, no-TTY text, and plain-renderer text.
  const text = `not kept automatically · ${explanation} · set services.web.home.path to keep one`;
  // Then all human surfaces carry one calm explanation.
  expect(
    buildInfoSummary(info).sections[0]?.rows[0]?.fields?.filter((field) => field.label === "home"),
  ).toEqual([{ label: "home", value: text }]);
  for (const ctx of [
    undefined,
    { mode: "plain", format: "text", isTTY: false, columns: undefined } as const,
    decorated(200),
  ]) {
    const rendered = stripAnsi(renderInfoAppResult(info, ctx));
    expect(rendered).toContain(text);
    expect(rendered.split("not kept automatically")).toHaveLength(2);
  }
});

test.each([
  undefined,
  { state: "disabled" },
  { state: "authored", target: "/root", mount: "volume" },
  { state: "persisted", target: "/root", store: "home-volume" },
] as const)("adds no home advice for %j", (home) => {
  // Given explicit intent, a persisted home, or an older plan.
  const info = result(service("web", [], home === undefined ? {} : { home }));
  // When rendering, then no automatic-persistence advice appears.
  expect(renderInfoAppResult(info)).not.toContain("\thome\t");
  expect(stripAnsi(renderInfoAppResult(info, decorated(160)))).not.toContain("not kept automatically");
});

test("escapes runtime names in unknown home advice", () => {
  // Given control characters in runtime-derived text.
  const info = result(
    service("web\nforged", [], {
      type: "node\u001b[31m",
      home: { state: "unknown", reason: "undeclared-user", user: "alice\nrow" },
    }),
  );
  // When rendering the home field, then control text cannot inject rows or styling.
  const field = buildInfoSummary(info).sections[0]?.rows[0]?.fields?.find((field) => field.label === "home");
  expect(field?.value).not.toContain("\n");
  expect(field?.value).not.toContain("\u001b");
});
