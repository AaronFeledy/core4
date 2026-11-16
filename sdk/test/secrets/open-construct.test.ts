import { describe, expect, test } from "bun:test";
import { createRedactor, findOpenSecretConstruct } from "@lando/sdk/secrets";

const redactor = createRedactor("secrets");
/** The detector runs on the prefix-redacted held block, never complete text. */
const open = (text: string) => findOpenSecretConstruct(redactor.redactPrefix(text));

describe("findOpenSecretConstruct", () => {
  test("reports an unclosed quoted assignment value", () => {
    expect(open('password="first')).toEqual({
      start: 0,
      valueStart: 9,
      quote: '"',
      keepsValueQuoting: false,
    });
  });

  test("reports an unclosed single-quoted signed query value", () => {
    expect(open("?api_token='first")).toEqual({
      start: 0,
      valueStart: 11,
      quote: "'",
      keepsValueQuoting: false,
    });
  });

  test("reports an unclosed colon-plus-quoted value anywhere in a line", () => {
    expect(open('password: "first')).toEqual({
      start: 0,
      valueStart: 10,
      quote: '"',
      keepsValueQuoting: true,
    });
  });

  test("reports an unclosed quoted-key member for JSON, Python, and escaped JSON", () => {
    expect(open('{"password":"first')).toEqual({
      start: 1,
      valueStart: 12,
      quote: '"',
      keepsValueQuoting: true,
    });
    expect(open("{'password': 'first")).toEqual({
      start: 1,
      valueStart: 13,
      quote: "'",
      keepsValueQuoting: true,
    });
    expect(open('{\\"password\\":\\"first')).toEqual({
      start: 1,
      valueStart: 14,
      quote: '"',
      keepsValueQuoting: true,
    });
  });

  test("reports an unclosed block-mapping key at line start", () => {
    expect(open('  db_password: "first')).toEqual({
      start: 0,
      valueStart: 15,
      quote: '"',
      keepsValueQuoting: true,
    });
    expect(open('- api_key: "first')).toEqual({
      start: 0,
      valueStart: 11,
      quote: '"',
      keepsValueQuoting: true,
    });
  });

  test("holds an escaped opener and points valueStart at its backslash", () => {
    // Given an escaped opener whose value has not arrived.
    const result = open('password=\\"first');
    // Then the detector reports the opener quote, and the held value starts at the backslash run.
    expect(result).toEqual({ start: 0, valueStart: 9, quote: '"', keepsValueQuoting: false });
    expect(redactor.redactPrefix('password=\\"first')[result?.valueStart ?? 0]).toBe("\\");
  });

  test("does not hold a value that a closing shell quote follows", () => {
    expect(redactor.redactString('RUN sh -c "mysql --password=secret"')).toBe(
      'RUN sh -c "mysql --password=[redacted]"',
    );
    expect(open('RUN sh -c "mysql --password=secret"')).toBeUndefined();
  });

  test("reports a bearer introducer followed only by whitespace", () => {
    expect(open("Authorization: Bearer ")).toEqual({
      start: 15,
      valueStart: 22,
      quote: undefined,
      keepsValueQuoting: false,
    });
    expect(open("Authorization: Bearer")).toEqual({
      start: 15,
      valueStart: 21,
      quote: undefined,
      keepsValueQuoting: false,
    });
  });

  test("does not report a construct whose closer is present", () => {
    // Given closed references and closed quoted values the pattern stages masked or kept whole.
    for (const input of [
      'password="$TOKEN"',
      '?sig="$TOKEN"',
      "Authorization: Bearer value",
      'password="value"',
      "{'password': \"value\"}",
      'db_password: "value"',
    ]) {
      // When the detector examines the prefix-redacted block.
      const result = open(input);
      // Then a present closer prevents a hold.
      expect(result, input).toBeUndefined();
    }
  });

  test("does not hold a quote that closes a shell string opened before the name", () => {
    expect(open('RUN echo "token=" > f')).toBeUndefined();
    expect(open('echo "NPM_TOKEN=" >> .npmrc')).toBeUndefined();
    expect(open('RUN echo "token = " > f')).toBeUndefined();
    expect(open('RUN echo "password: " > f')).toBeUndefined();
  });

  test("the quoted-key member form has no same-quote exclusion", () => {
    // Given a member key whose own quote is immediately preceded by the same quote character.
    // A key quote is not a shell string, so the value opener is still unproven.
    const result = open('"password":"first');
    // Then the opener is held.
    expect(result).toEqual({ start: 0, valueStart: 11, quote: '"', keepsValueQuoting: true });
  });

  test("returns the leftmost open construct across classes", () => {
    // Given an open assignment before an incomplete bearer value.
    const input = 'a password="first\nAuthorization: Bearer';
    // When the detector examines the block.
    const result = open(input);
    // Then the earlier assignment determines the hold boundary.
    expect(result).toEqual({ start: 2, valueStart: 11, quote: '"', keepsValueQuoting: false });
  });

  test("returns an open query before a later open assignment", () => {
    // Given an open query preceding an assignment with a different quote.
    const input = "?sig='first\npassword=\"second";
    // When the detector examines the block.
    const result = open(input);
    // Then source order wins over the order in which grammar classes are scanned.
    expect(result).toEqual({ start: 0, valueStart: 5, quote: "'", keepsValueQuoting: false });
  });

  test("returns undefined for ordinary output", () => {
    expect(open("installing packages\ndone")).toBeUndefined();
    expect(open("The password is required")).toBeUndefined();
    expect(open("SecretNotFoundError: missing DB_PASSWORD")).toBeUndefined();
  });
});
