import { describe, expect, test } from "bun:test";

import { Effect, Exit, Layer } from "effect";

import { type AppPlan, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { EventService, ShellRunner } from "@lando/sdk/services";

import { RedactionService } from "../../../src/redaction/service.ts";

import { type OpenAppOptions, openForPlan, renderOpenAppResult } from "../../../src/cli/commands/open.ts";

const route = (over: Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string }): RoutePlan => ({
  ...over,
  service: ServiceName.make(over.service),
});

const makePlan = (routes: RoutePlan[], serviceNames: string[]): AppPlan => {
  const services: Record<string, unknown> = {};
  for (const name of serviceNames) services[name] = { name, routes: [], endpoints: [] };
  return {
    id: "myapp",
    name: "myapp",
    root: "/srv/apps/myapp",
    services,
    routes,
  } as unknown as AppPlan;
};

const record = () => ({ commands: [] as string[], events: [] as { tag: string; url: string }[] });

const layers = (rec: ReturnType<typeof record>) =>
  Layer.mergeAll(
    Layer.succeed(ShellRunner, {
      exec: (command: string) => {
        rec.commands.push(command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
      run: () => Effect.die("nu"),
      runScript: () => Effect.die("nu"),
      interactive: () => Effect.die("nu"),
    }),
    Layer.succeed(EventService, {
      publish: (event: { _tag: string; url?: string }) => {
        rec.events.push({ tag: event._tag, url: event.url ?? "" });
        return Effect.void;
      },
      subscribe: () => Effect.die("nu") as never,
      subscribeQueue: Effect.die("nu") as never,
      waitFor: () => Effect.die("nu") as never,
      waitForAny: () => Effect.die("nu") as never,
      query: () => Effect.die("nu") as never,
    }),
    Layer.succeed(RedactionService, {
      forProfile: () => Effect.succeed({ redactString: (t: string) => `RED(${t})`, redactValue: (v) => v }),
    }),
  );

const run = (plan: AppPlan, options: OpenAppOptions, rec: ReturnType<typeof record>) =>
  Effect.runPromiseExit(openForPlan(plan, options).pipe(Effect.provide(layers(rec))));

const httpsPlan = () =>
  makePlan([route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" })], ["web"]);

describe("openForPlan", () => {
  test("S5 no routes fails with OpenTargetUnresolvedError listing services", async () => {
    const rec = record();
    const exit = await run(makePlan([], ["web", "db"]), { platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error as {
        _tag: string;
        message: string;
        services?: string[];
        remediation?: string;
      };
      expect(err._tag).toBe("OpenTargetUnresolvedError");
      expect(err.services).toEqual(["web", "db"]);
      expect(err.message).toContain("web, db");
      expect(err.remediation).toContain("proxy");
    }
    expect(rec.commands).toEqual([]);
  });

  test("selection miss reports the bad selector instead of missing proxy config", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { service: "api", platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error as {
        readonly _tag: string;
        readonly message: string;
        readonly remediation?: string;
      };
      expect(err._tag).toBe("OpenTargetUnresolvedError");
      expect(err.message).toContain("No openable URL matched --service api");
      expect(err.remediation).toContain("Choose one of the listed services");
      expect(err.remediation).not.toContain("proxy");
    }
    expect(rec.commands).toEqual([]);
  });

  test("S7 headless host degrades to printed with a note, no opener, no events", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { platform: "linux", env: {} }, rec);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.launch).toBe("headless-degraded");
      expect(exit.value.note).toBeDefined();
      expect(exit.value.targets.map((t) => t.url)).toEqual(["https://web.myapp.lndo.site"]);
    }
    expect(rec.commands).toEqual([]);
    expect(rec.events).toEqual([]);
  });

  test("S9 opening publishes redacted pre/post-open-url per URL and calls the opener", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.launch).toBe("opened");
    expect(rec.commands).toEqual(["xdg-open 'https://web.myapp.lndo.site'"]);
    expect(rec.events).toEqual([
      { tag: "pre-open-url", url: "RED(https://web.myapp.lndo.site)" },
      { tag: "post-open-url", url: "RED(https://web.myapp.lndo.site)" },
    ]);
  });

  test("--print skips opening and events", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { print: true, platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.launch).toBe("printed");
    expect(rec.commands).toEqual([]);
    expect(rec.events).toEqual([]);
  });

  test("--json without explicit selection + tty does not launch", async () => {
    const rec = record();
    const exit = await run(
      httpsPlan(),
      { json: true, ttyPresent: true, platform: "linux", env: { DISPLAY: ":0" } },
      rec,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.launch).toBe("printed");
    expect(rec.commands).toEqual([]);
  });

  test("--json on a headless host reports headless degradation", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { json: true, platform: "linux", env: {} }, rec);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.launch).toBe("headless-degraded");
      expect(exit.value.note).toContain("No display server detected");
    }
    expect(rec.commands).toEqual([]);
    expect(rec.events).toEqual([]);
  });

  test("--json WITH explicit --service selection + tty launches", async () => {
    const rec = record();
    const exit = await run(
      httpsPlan(),
      { json: true, ttyPresent: true, service: "web", platform: "linux", env: { DISPLAY: ":0" } },
      rec,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.launch).toBe("opened");
    expect(rec.commands).toEqual(["xdg-open 'https://web.myapp.lndo.site'"]);
  });
});

describe("renderOpenAppResult", () => {
  test("prints resolved urls and launch outcome", () => {
    const text = renderOpenAppResult({
      app: "myapp",
      targets: [
        {
          service: "web",
          hostname: "web.myapp.lndo.site",
          scheme: "https",
          url: "https://web.myapp.lndo.site",
        },
      ],
      launch: "printed",
    });
    expect(text).toContain("https://web.myapp.lndo.site");
  });
});
