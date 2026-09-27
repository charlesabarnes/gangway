import { z } from "zod";
import { email, password } from "./api.ts";

export const PasswordResetRequestSchema = z.strictObject({ email });

export const MailTestSchema = z.strictObject({ to: email });

// The secret from an emailed link: 32 random bytes, base64url.
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "not a link from gangway");

export const EmailLinkSchema = z.strictObject({ token: linkToken });

export const RedeemEmailLinkSchema = z.strictObject({ token: linkToken, password });
