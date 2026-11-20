import { join } from "node:path";
import { RequestPolicy, layerWith } from "@lando/http-client";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { makeLandoPaths } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { FETCH_ROUTE_TOKEN, type FetchProps } from "@lando/sdk/docs/components";
import { CommandResultEnvelope, InfoAppResult } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export class ScenarioFetchError extends Schema.TaggedError<ScenarioFetchError>()("ScenarioFetchError", {
  message: Schema.String,
}) {}

const InfoJson = Schema.fromJsonString(
  Schema.Struct({ ...CommandResultEnvelope.fields, ok: Schema.Literal(true), result: InfoAppResult }),
);

export const resolveFetchUrl = Effect.fnUntraced(function* (
  template: string,
  readInfo: Effect.Effect<string, ScenarioFetchError>,
) {
  let target = template;
  const service = FETCH_ROUTE_TOKEN.exec(template)?.[1];
  if (service !== undefined) {
    const { result } = yield* Schema.decodeUnknownEffect(InfoJson)(yield* readInfo).pipe(
      mapFailures(() => new ScenarioFetchError({ message: "Could not decode the lando info JSON result." })),
    );
    const connections = result.services.find((item) => item.service === service)?.connections ?? [];
    const routes = connections.filter((item) => item.source === "route" && item.binding === "assigned");
    const selected = routes.find((item) => item.protocol === "https") ?? routes[0];
    if (selected === undefined) {
      return yield* new ScenarioFetchError({
        message: `No assigned host route for ${service}. Start the app and check lando info.`,
      });
    }
    const suffix = template.replace(FETCH_ROUTE_TOKEN, "");
    target = `${suffix.startsWith("/") ? selected.url.replace(/\/$/u, "") : selected.url}${suffix}`;
  }
  const url = URL.parse(target);
  if (url === null || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return yield* new ScenarioFetchError({ message: "Fetch needs an HTTP(S) URL without credentials." });
  }
  return url;
});

export const readScenarioCa = Effect.fnUntraced(function* (cwd: string) {
  const { binDir } = makeLandoPaths();
  const mkcert = join(binDir, process.platform === "win32" ? "mkcert.exe" : "mkcert");
  return yield* Effect.tryPromise({
    try: async (signal) => {
      // Read the CA installed by setup rather than creating one in the test.
      const child = Bun.spawn([mkcert, "-CAROOT"], { cwd, signal, stdout: "pipe", stderr: "ignore" });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      const root = output.trim();
      if (code !== 0 || root === "") return undefined;
      return await Bun.file(join(root, "rootCA.pem")).text();
    },
    catch: () => missingCa(),
  }).pipe(Effect.flatMap((pem) => (pem ? Effect.succeed(pem) : Effect.fail(missingCa()))));
});

const missingCa = () =>
  new ScenarioFetchError({
    message: "Fetch could not read Lando's local CA. Run `lando setup` on this host.",
  });

type FetchRequest = Pick<FetchProps, "method" | "headers">;

export const requestScenarioRoute = Effect.fn("ScenarioContext.fetch")(function* (
  url: URL,
  props: FetchRequest,
  ca: string | undefined,
) {
  if (url.protocol === "https:" && !ca) return yield* missingCa();
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(props.method ?? "GET")(url, {
      headers: { ...props.headers },
    });
    const response = yield* client.execute(request);
    return { status: response.status, headers: response.headers, body: yield* response.text };
  }).pipe(
    Effect.provide(layerWith({ env: {}, systemCaPems: () => [] })),
    Effect.provideService(RequestPolicy, {
      connectionTarget: { origin: url.origin, address: "127.0.0.1" },
      redirect: "manual",
    }),
    Effect.provideService(NetworkTrust, {
      proxy: { noProxy: [] },
      caPems: ca === undefined ? [] : [ca],
      trustHost: false,
    }),
    Effect.timeout("15 seconds"),
    mapFailures(
      () =>
        new ScenarioFetchError({
          message: `Fetch could not complete the ${props.method ?? "GET"} request. Check the router port and TLS certificate.`,
        }),
    ),
  );
});
