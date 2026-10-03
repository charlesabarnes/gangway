import nodemailer from "nodemailer";
import { conflict, errorMessage, unprocessable } from "../errors.ts";

export type MailPurpose = "invite" | "reset" | "test";

/** `purpose` and `link` let an HTTPS endpoint render its own message; SMTP sends `text`. */
export type Mail = {
  to: string;
  subject: string;
  text: string;
  purpose?: MailPurpose;
  link?: string;
};
export type Send = (m: Mail & { from: string }) => Promise<void>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type MailerDeps = {
  url: () => string;
  from: () => string;
  transport?: (url: string) => Send;
  fetch?: FetchLike;
};

const HTTPS_TIMEOUT_MS = 20_000;
const MAX_ERROR_CHARS = 200;

// A dead relay must fail a request in seconds, not hang it on the OS's TCP timeout.
function smtp(url: string): Send {
  const options = {
    url,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
  const t = nodemailer.createTransport(options); // NOSONAR the operator's relay URL; smtps or STARTTLS is theirs to choose
  return async (m) => {
    await t.sendMail(m);
  };
}

// One JSON POST per message; the URL's password (or user name) goes as a bearer token instead.
export function https(url: string, fetchImpl: FetchLike = (u, init) => fetch(u, init)): Send {
  const target = new URL(url);
  const credential = decodeURIComponent(target.password || target.username);
  target.username = "";
  target.password = "";
  const endpoint = target.toString();
  return async (m) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential !== "") {
      headers.authorization = `Bearer ${credential}`;
    }
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: m.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        purpose: m.purpose ?? null,
        link: m.link ?? null,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(HTTPS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).trim().slice(0, MAX_ERROR_CHARS);
      throw new Error(`HTTP ${res.status}${detail === "" ? "" : `: ${detail}`}`);
    }
  };
}

export class Mailer {
  readonly #d: MailerDeps;
  readonly #transport: (url: string) => Send;
  #cached: { url: string; send: Send } | null = null;

  constructor(d: MailerDeps) {
    this.#d = d;
    this.#transport =
      d.transport ?? ((url) => (url.startsWith("https://") ? https(url, d.fetch) : smtp(url)));
  }

  get configured(): boolean {
    return this.#d.url() !== "" && this.#d.from() !== "";
  }

  async send(m: Mail): Promise<void> {
    const url = this.#d.url();
    const from = this.#d.from();
    if (url === "" || from === "") {
      throw conflict("email is not set up on this server");
    }
    if (this.#cached?.url !== url) {
      this.#cached = { url, send: this.#transport(url) };
    }
    try {
      await this.#cached.send({ ...m, from });
    } catch (e) {
      // A 4xx: a 5xx hides its detail, and the admin needs the relay's words (no URL in them).
      throw unprocessable(`the mail server refused: ${errorMessage(e)}`);
    }
  }
}
