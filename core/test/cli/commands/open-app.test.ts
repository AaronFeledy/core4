import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Layer, Result } from "effect";

import { ShellExecError } from "@lando/sdk/errors";
import { type AppPlan, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { EventService, ShellRunner } from "@lando/sdk/services";

import { RedactionService, registerRedactionValues } from "@lando/redaction/service";

import {
  type OpenAppOptions,
  openForPlan,
  openOptionsFromInput,
  renderOpenAppResult,
} from "../../../src/cli/commands/open.ts";
import type { RenderContext } from "../../../src/cli/renderer-boundary.ts";
import { renderTerminalQr } from "../../../src/cli/terminal-qr.ts";

const route = (over: Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string }): RoutePlan => ({
  priority: 2,
  ...over,
  service: ServiceName.make(over.service),
  backend: { service: ServiceName.make(over.service), protocol: "http", port: 80 },
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

const record = (failOnCommand?: string) => ({
  commands: [] as string[],
  events: [] as { tag: string; url: string }[],
  failOnCommand,
});

const layers = (rec: ReturnType<typeof record>) =>
  Layer.mergeAll(
    Layer.succeed(ShellRunner, {
      exec: (command: string) => {
        rec.commands.push(command);
        if (rec.failOnCommand === command) {
          return Effect.fail(new ShellExecError({ message: "open failed", command, exitCode: 1 }));
        }
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
      registerValues: registerRedactionValues,
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
    if (Exit.isFailure(exit)) {
      const err = Result.getOrThrow(Cause.findError(exit.cause)) as {
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

  test("a disabled router says so instead of blaming missing proxy config", async () => {
    // Given: the app declares a route, but the router that would publish it is off.
    const rec = record();
    const plan = { ...httpsPlan(), router: { enabled: false } };

    // When
    const exit = await run(plan, { platform: "linux", env: { DISPLAY: ":0" } }, rec);

    // Then: the diagnostic names the real cause and the real way out.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Result.getOrThrow(Cause.findError(exit.cause)) as {
        readonly _tag: string;
        readonly message: string;
        readonly remediation?: string;
      };
      expect(err._tag).toBe("OpenTargetUnresolvedError");
      expect(err.message).toContain("router is disabled");
      expect(err.remediation).toContain("router:");
      expect(err.remediation).toContain("enabled: true");
      expect(err.remediation).not.toContain("Declare a route");
    }
    expect(rec.commands).toEqual([]);
  });

  test("a disabled router names the unpublished --route even when a host port exists", async () => {
    // Given: a declared hostname plus an unrelated published port must not look like a bad selector.
    const rec = record();
    const plan = {
      ...httpsPlan(),
      router: { enabled: false },
      services: {
        web: {
          name: "web",
          routes: [],
          endpoints: [{ _tag: "published", protocol: "http", port: 8080, publication: { hostPort: 8080 } }],
        },
      },
    } as AppPlan;

    // When
    const exit = await run(
      plan,
      { route: "web.myapp.lndo.site", platform: "linux", env: { DISPLAY: ":0" } },
      rec,
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Result.getOrThrow(Cause.findError(exit.cause)) as {
        readonly _tag: string;
        readonly message: string;
        readonly remediation?: string;
      };
      expect(err._tag).toBe("OpenTargetUnresolvedError");
      expect(err.message).toContain("--route web.myapp.lndo.site");
      expect(err.message).toContain("router is disabled");
      expect(err.remediation).toContain("router:");
      expect(err.remediation).toContain("enabled: true");
      expect(err.remediation).not.toContain("Choose one of the listed services");
    }
    expect(rec.commands).toEqual([]);
  });

  test("selection miss reports the bad selector instead of missing proxy config", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { service: "api", platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Result.getOrThrow(Cause.findError(exit.cause)) as {
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

  test("selection miss reports --route when both --route and --service are set", async () => {
    const rec = record();
    const exit = await run(
      httpsPlan(),
      { route: "missing.myapp.lndo.site", service: "web", platform: "linux", env: { DISPLAY: ":0" } },
      rec,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Result.getOrThrow(Cause.findError(exit.cause)) as {
        readonly _tag: string;
        readonly message: string;
      };
      expect(err._tag).toBe("OpenTargetUnresolvedError");
      expect(err.message).toContain("No openable URL matched --route missing.myapp.lndo.site");
      expect(err.message).not.toContain("--service web");
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

  test("failed later opens still publish a matching post-open-url event", async () => {
    const secondCommand = "xdg-open 'https://api.myapp.lndo.site'";
    const rec = record(secondCommand);
    const exit = await run(
      makePlan(
        [
          route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" }),
          route({ hostname: "api.myapp.lndo.site", scheme: "https", service: "api" }),
        ],
        ["web", "api"],
      ),
      { all: true, platform: "linux", env: { DISPLAY: ":0" } },
      rec,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(rec.commands).toEqual(["xdg-open 'https://web.myapp.lndo.site'", secondCommand]);
    expect(rec.events).toEqual([
      { tag: "pre-open-url", url: "RED(https://web.myapp.lndo.site)" },
      { tag: "post-open-url", url: "RED(https://web.myapp.lndo.site)" },
      { tag: "pre-open-url", url: "RED(https://api.myapp.lndo.site)" },
      { tag: "post-open-url", url: "RED(https://api.myapp.lndo.site)" },
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

  test("--qr prints and does not launch a browser", async () => {
    const rec = record();
    const exit = await run(httpsPlan(), { qr: true, platform: "linux", env: { DISPLAY: ":0" } }, rec);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.launch).toBe("printed");
      expect(exit.value.targets.map((target) => target.url)).toEqual(["https://web.myapp.lndo.site"]);
    }
    expect(rec.commands).toEqual([]);
    expect(rec.events).toEqual([]);
  });

  test("openOptionsFromInput maps --qr", () => {
    expect(openOptionsFromInput({ flags: { qr: true } }).qr).toBe(true);
    expect(openOptionsFromInput({ flags: { print: true } }).qr).toBeUndefined();
  });

  test.each(["json", "yaml"])(
    "--format=%s without explicit selection + tty does not launch",
    async (format) => {
      const rec = record();
      const exit = await run(
        httpsPlan(),
        {
          ...openOptionsFromInput({ flags: { format } }),
          ttyPresent: true,
          platform: "linux",
          env: { DISPLAY: ":0" },
        },
        rec,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.launch).toBe("printed");
      expect(rec.commands).toEqual([]);
    },
  );

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
  const printed = {
    app: "myapp",
    targets: [
      {
        service: "web",
        hostname: "web.myapp.lndo.site",
        scheme: "https" as const,
        url: "https://web.myapp.lndo.site",
      },
    ],
    launch: "printed" as const,
  };
  const tty: RenderContext = { mode: "lando", format: "text", columns: 80, isTTY: true };
  const qrFor = (url: string): string => {
    const qr = renderTerminalQr(url);
    expect(qr).toBeDefined();
    return qr ?? "";
  };

  test("prints resolved urls and launch outcome", () => {
    const text = renderOpenAppResult(printed);
    expect(text).toContain("https://web.myapp.lndo.site");
    expect(text).not.toContain(qrFor("https://web.myapp.lndo.site").trimEnd());
  });

  test("local *.lndo.site URLs get a QR only when --qr is set", () => {
    const withoutFlag = renderOpenAppResult(printed, tty);
    const withFlag = renderOpenAppResult(printed, tty, { qr: true });
    expect(withoutFlag).toBe("Resolved:\nweb\thttps://web.myapp.lndo.site\n");
    expect(withFlag.startsWith(withoutFlag)).toBe(true);
    expect(withFlag).toContain(qrFor("https://web.myapp.lndo.site").trimEnd());
  });

  test("loopback 127.0.0.1 URLs get a QR only when --qr is set", () => {
    const loopback = {
      ...printed,
      targets: [
        {
          service: "web",
          hostname: "127.0.0.1",
          scheme: "http" as const,
          url: "http://127.0.0.1:8080",
        },
      ],
    };
    expect(renderOpenAppResult(loopback, tty)).toBe("Resolved:\nweb\thttp://127.0.0.1:8080\n");
    expect(renderOpenAppResult(loopback, tty, { qr: true })).toContain(
      qrFor("http://127.0.0.1:8080").trimEnd(),
    );
  });

  test("localhost and ::1 URLs get a QR only when --qr is set", () => {
    const localhost = {
      ...printed,
      targets: [
        {
          service: "web",
          hostname: "localhost",
          scheme: "http" as const,
          url: "http://localhost:8080",
        },
      ],
    };
    const ipv6 = {
      ...printed,
      targets: [
        {
          service: "web",
          hostname: "[::1]",
          scheme: "http" as const,
          url: "http://[::1]:8080",
        },
      ],
    };
    expect(renderOpenAppResult(localhost, tty)).toBe("Resolved:\nweb\thttp://localhost:8080\n");
    expect(renderOpenAppResult(localhost, tty, { qr: true })).toContain(
      qrFor("http://localhost:8080").trimEnd(),
    );
    expect(renderOpenAppResult(ipv6, tty)).toBe("Resolved:\nweb\thttp://[::1]:8080\n");
    expect(renderOpenAppResult(ipv6, tty, { qr: true })).toContain(qrFor("http://[::1]:8080").trimEnd());
  });

  test("--qr on a pipe prints URLs and skips the QR", () => {
    const text = renderOpenAppResult(printed, { ...tty, isTTY: false }, { qr: true });
    expect(text).toBe("Resolved:\nweb\thttps://web.myapp.lndo.site\n");
  });

  test("prints the URL list then unlabeled QRs for each target", () => {
    const result = {
      ...printed,
      targets: [
        {
          service: "web",
          hostname: "web.myapp.lndo.site",
          scheme: "https" as const,
          url: "https://web.myapp.lndo.site",
        },
        {
          service: "api",
          hostname: "api.myapp.lndo.site",
          scheme: "https" as const,
          url: "https://api.myapp.lndo.site",
        },
      ],
    };
    const heading = "Resolved:\nweb\thttps://web.myapp.lndo.site\napi\thttps://api.myapp.lndo.site\n";
    expect(renderOpenAppResult(result, tty, { qr: true })).toBe(
      `${heading}${qrFor("https://web.myapp.lndo.site")}${qrFor("https://api.myapp.lndo.site")}`,
    );
  });

  test("skips a QR for an overlong URL and still prints it", () => {
    const overlong = `https://share.example.test/${"a".repeat(4000)}`;
    const result = {
      ...printed,
      targets: [
        {
          service: "web",
          hostname: "share.example.test",
          scheme: "https" as const,
          url: overlong,
        },
      ],
    };
    expect(renderOpenAppResult(result, tty, { qr: true })).toBe(`Resolved:\nweb\t${overlong}\n`);
  });

  test("--qr stays URL-only in JSON format", () => {
    const text = renderOpenAppResult(printed, { ...tty, format: "json" }, { qr: true });
    expect(text).toBe("Resolved:\nweb\thttps://web.myapp.lndo.site\n");
  });
});
