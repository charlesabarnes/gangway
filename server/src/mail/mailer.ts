import nodemailer from "nodemailer";
import { conflict, errorMessage, unprocessable } from "../errors.ts";

export type Mail = { to: string; subject: string; text: string };
export type Send = (m: Mail & { from: string }) => Promise<void>;

export type MailerDeps = {
  url: () => string;
  from: () => string;
  /** Tests pass a fake; production speaks SMTP through nodemailer. */
  transport?: (url: string) => Send;
};

// A dead relay must fail a request in seconds, not hang it on the OS's TCP timeout.
function smtp(url: string): Send {
  const t = nodemailer.createTransport({
    url,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return async (m) => {
    await t.sendMail(m);
  };
}

/** Outgoing email over SMTP; unconfigured until an SMTP URL and a From address are set. */
export class Mailer {
  readonly #d: MailerDeps;
  readonly #transport: (url: string) => Send;
  #cached: { url: string; send: Send } | null = null;

  constructor(d: MailerDeps) {
    this.#d = d;
    this.#transport = d.transport ?? smtp;
  }

  get configured(): boolean {
    return this.#d.url() !== "" && this.#d.from() !== "";
  }

  async send(m: Mail): Promise<void> {
    const url = this.#d.url();
    const from = this.#d.from();
    if (url === "" || from === "") throw conflict("email is not set up on this server");
    // One transport per URL, so a changed setting takes effect on the next send.
    if (this.#cached?.url !== url) this.#cached = { url, send: this.#transport(url) };
    try {
      await this.#cached.send({ ...m, from });
    } catch (e) {
      // A 4xx, because a 5xx's detail is hidden and the relay's own words (bad login, refused
      // sender) are what the admin needs. The URL, and so the password, is not in them.
      throw unprocessable(`the mail server refused: ${errorMessage(e)}`);
    }
  }
}
