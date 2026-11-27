import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";

import { type AccountHomeHost, homeOfUid } from "../../src/host/account-home";

const PASSWD = "root:x:0:0:root:/root:/bin/bash\ndev:x:1000:1000:Dev:/home/dev:/bin/bash\n";

const fakeHost = (input: {
  readonly getent?: Readonly<Record<string, string>>;
  readonly passwd?: string;
}) => {
  const ran: string[][] = [];
  const host: AccountHomeHost = {
    exists: (path) => input.getent !== undefined && path === "/usr/bin/getent",
    run: (argv) => {
      ran.push([...argv]);
      return input.getent?.[argv[2] ?? ""];
    },
    readPasswd: () => input.passwd,
  };
  return { host, ran };
};

describe("homeOfUid", () => {
  test("asks the account database by absolute path, so directory accounts resolve as at login", () => {
    // Given an LDAP account that /etc/passwd does not list.
    const { host, ran } = fakeHost({
      getent: { "1500": "ldapdev:*:1500:1500:LDAP Dev:/srv/home/ldapdev:/bin/bash\n" },
      passwd: PASSWD,
    });

    expect(homeOfUid(1500, host)).toBe("/srv/home/ldapdev");
    expect(ran).toEqual([["/usr/bin/getent", "passwd", "1500"]]);
  });

  test("reads /etc/passwd when no getent runs", () => {
    expect(homeOfUid(1000, fakeHost({ passwd: PASSWD }).host)).toBe("/home/dev");
  });

  test("an account neither knows has no home, and nor does an id that is not one", () => {
    const { host } = fakeHost({ getent: {}, passwd: PASSWD });

    expect([homeOfUid(4242, host), homeOfUid(-1, host), homeOfUid(1.5, host)]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("never takes another account's line for this uid", () => {
    const { host } = fakeHost({ getent: { "10": "ten:x:100:100::/home/hundred:/bin/sh\n" } });

    expect(homeOfUid(10, host)).toBeUndefined();
  });

  test.skipIf(process.platform !== "linux")("agrees with the system's own lookup for this account", () => {
    const uid = process.getuid?.() ?? 0;

    expect(homeOfUid(uid)).toBe(userInfo().homedir);
  });
});
