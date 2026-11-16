import { describe, expect, test } from "bun:test";
import { createRedactor, findOpenSecretConstruct } from "@lando/sdk/secrets";

const redactor = createRedactor("secrets");
const open = (text: string) => findOpenSecretConstruct(redactor.redactString(text));

describe("findOpenSecretConstruct", () => {
  test("reports an unclosed quoted assignment value", () => {
    expect(open('password="first')).toEqual({ start: 0, valueStart: 9 });
  });

  test("reports an unclosed single-quoted signed query value", () => {
    expect(open("?api_token='first")).toEqual({ start: 0, valueStart: 11 });
  });

  test("does not hold a value that a closing shell quote follows", () => {
    expect(redactor.redactString('RUN sh -c "mysql --password=secret"')).toBe(
      'RUN sh -c "mysql --password=[redacted]"',
    );
    expect(open('RUN sh -c "mysql --password=secret"')).toBeUndefined();
    expect(open('password=\\"first')).toBeUndefined();
  });

  test("reports a bearer introducer followed only by whitespace", () => {
    expect(open("Authorization: Bearer ")).toEqual({ start: 15, valueStart: 22 });
    expect(open("Authorization: Bearer")).toEqual({ start: 15, valueStart: 21 });
  });

  test("does not report a construct whose closer is present", () => {
    // Given closed references whose quotes survive canonical redaction.
    for (const input of ['password="$TOKEN"', '?sig="$TOKEN"', "Authorization: Bearer value"]) {
      // When the detector examines the redacted block.
      const result = open(input);
      // Then a present closer or bearer value prevents a hold.
      expect(result, input).toBeUndefined();
    }
  });

  test("does not hold a quote that closes a shell string opened before the name", () => {
    expect(open('RUN echo "token=" > f')).toBeUndefined();
    expect(open('echo "NPM_TOKEN=" >> .npmrc')).toBeUndefined();
  });

  test("returns the leftmost open construct across classes", () => {
    // Given an open assignment before an incomplete bearer value.
    const input = 'a password="first\nAuthorization: Bearer';
    // When the detector examines the redacted block.
    const result = open(input);
    // Then the earlier assignment determines the hold boundary.
    expect(result).toEqual({ start: 2, valueStart: 11 });
  });

  test("returns an open query before a later open assignment", () => {
    // Given an open query preceding an assignment with a different quote.
    const input = "?sig='first\npassword=\"second";
    // When the detector examines the redacted block.
    const result = open(input);
    // Then source order wins over the order in which grammar classes are scanned.
    expect(result).toEqual({ start: 0, valueStart: 5 });
  });

  test("returns undefined for ordinary output", () => {
    expect(open("installing packages\ndone")).toBeUndefined();
  });
});
