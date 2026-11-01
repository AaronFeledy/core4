import { describe, expect, test } from "bun:test";
import { ListenerAuthority, formatListenerAuthority } from "@lando/sdk/schema";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(ListenerAuthority);

describe("ListenerAuthority", () => {
  test.each([
    { owner: "application", daemon: "Flask", port: 5000, variables: ["PORT", "FLASK_RUN_PORT"] },
    { owner: "launcher", daemon: "MongoDB", port: 27018, setting: "--port 27018" },
    { owner: "image", daemon: "Tomcat", port: 8081, setting: '<Connector port="8081">', file: "server.xml" },
  ])("round-trips the $owner arm strictly", (authority) => {
    // Given / When
    const decoded = decode(Schema.encodeSync(ListenerAuthority)(decode(authority)), {
      onExcessProperty: "error",
    });

    // Then
    expect(decoded).toEqual(decode(authority));
  });

  test.each([
    { owner: "launcher", daemon: "MongoDB", port: 27018 },
    { owner: "image", daemon: "Tomcat", port: 8081 },
    { owner: "application", daemon: "Flask", port: 5000, variables: [] },
    { owner: "launcher", daemon: "", port: 27018, setting: "--port 27018" },
    { owner: "launcher", daemon: "MongoDB", port: 0, setting: "--port 0" },
  ])("rejects an arm missing its required advice: %j", (authority) => {
    expect(() => decode(authority)).toThrow();
  });
});

describe("formatListenerAuthority", () => {
  test("tells an application owner which variables Lando sets and where to bind", () => {
    expect(
      formatListenerAuthority(
        decode({ owner: "application", daemon: "Flask", port: 5000, variables: ["PORT", "FLASK_RUN_PORT"] }),
      ),
    ).toBe(
      "Make your server listen on 0.0.0.0:5000; your application owns this listener and Lando sets `PORT` and `FLASK_RUN_PORT` to 5000.",
    );
    expect(
      formatListenerAuthority(
        decode({ owner: "application", daemon: "Go", port: 8080, variables: ["PORT"] }),
      ),
    ).toBe(
      "Make your server listen on 0.0.0.0:8080; your application owns this listener and Lando sets `PORT` to 8080.",
    );
  });

  test("names the argument an authored launcher must pass", () => {
    expect(
      formatListenerAuthority(
        decode({ owner: "launcher", daemon: "MongoDB", port: 27018, setting: "--port 27018" }),
      ),
    ).toBe(
      "Pass `--port 27018` to MongoDB in your command or entrypoint; Lando sets the listener from port: only in its own launcher.",
    );
  });

  test("names the setting and file a custom image must carry", () => {
    expect(
      formatListenerAuthority(
        decode({
          owner: "image",
          daemon: "Tomcat",
          port: 8081,
          setting: '<Connector port="8081">',
          file: "server.xml",
        }),
      ),
    ).toBe(
      'Set `<Connector port="8081">` in server.xml for Tomcat in your image or build; Lando sets the listener from port: only in configuration it owns.',
    );
    expect(
      formatListenerAuthority(
        decode({ owner: "image", daemon: "Apache", port: 8080, setting: "Listen 8080" }),
      ),
    ).toBe(
      "Set `Listen 8080` for Apache in your image or build; Lando sets the listener from port: only in configuration it owns.",
    );
  });
});
