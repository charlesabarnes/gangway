import { describe, expect, test } from "bun:test";
import { Mailer, https } from "../../src/mail/mailer.ts";

describe("the https transport", () => {
  type Call = { url: string; init: RequestInit };
  function capture(status = 202, body = "") {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    };
    return { calls, fetchImpl };
  }
  const mail = {
    from: "gangway <noreply@example.com>",
    to: "bob@example.com",
    subject: "Reset your gangway password",
    text: "Choose a new password:\nhttps://app.example.com/set-password#abc",
    purpose: "reset" as const,
    link: "https://app.example.com/set-password#abc",
  };

  test("posts JSON with the password as a bearer token, not in the URL", async () => {
    const { calls, fetchImpl } = capture();
    await https("https://mailer:s3cr%2Ft@mail.example.com/v1/send?x=1", fetchImpl)(mail);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://mail.example.com/v1/send?x=1");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer s3cr/t",
    });
    expect(JSON.parse(String(init.body))).toEqual(mail);
  });

  test("falls back to the user name, and sends null for a missing purpose", async () => {
    const { calls, fetchImpl } = capture();
    await https(
      "https://tok123@mail.example.com/send",
      fetchImpl,
    )({
      from: "noreply@example.com",
      to: "a@b.c",
      subject: "s",
      text: "t",
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok123");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ purpose: null, link: null });
  });

  test("sends no authorization header without credentials", async () => {
    const { calls, fetchImpl } = capture();
    await https("https://mail.example.com/send", fetchImpl)(mail);
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
  });

  test("a refusal names the status only, never what the endpoint echoed", async () => {
    const { fetchImpl } = capture(403, `bad token topsecret for ${mail.link}`);
    const err = await https(
      "https://u:topsecret@mail.example.com/send",
      fetchImpl,
    )(mail).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("the endpoint answered HTTP 403");
  });

  test("the mailer picks it for an https:// URL and reports a refusal as a 422", async () => {
    const { calls, fetchImpl } = capture(500, "down");
    const mailer = new Mailer({
      url: () => "https://:tok@mail.example.com/send",
      from: () => "noreply@example.com",
      fetch: fetchImpl,
    });
    await expect(mailer.send({ to: "a@b.c", subject: "s", text: "t" })).rejects.toMatchObject({
      status: 422,
      message: "the mail server refused: the endpoint answered HTTP 500",
    });
    expect(calls[0]!.url).toBe("https://mail.example.com/send");
  });
});
