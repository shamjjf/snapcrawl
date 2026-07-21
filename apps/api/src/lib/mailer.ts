import nodemailer, { type Transporter } from "nodemailer";
import { isProd } from "../config/env";
import { log } from "./logger";

// Outbound email (FR-BE-005). SMTP when configured; otherwise the message is
// written to the log so local development and CI still exercise the whole reset
// flow without an SMTP server to talk to.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

let cached: Transporter | null = null;

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

function transporter(): Transporter {
  cached ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    // STARTTLS on 587 (secure:false) vs implicit TLS on 465 (secure:true).
    secure: (process.env.SMTP_SECURE ?? "false") === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return cached;
}

/**
 * Send a message.
 *
 * With no SMTP_HOST this logs instead of sending — which is right for dev, and
 * wrong for production: an operator who never sets SMTP would otherwise ship a
 * "check your email" flow where the email only ever lands in a server log. So
 * in production, an unconfigured mailer is a hard failure rather than a quiet
 * downgrade.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (!smtpConfigured()) {
    if (isProd()) {
      throw new Error("SMTP_HOST is not configured — cannot send mail in production.");
    }
    log.warn("mail not sent — no SMTP configured, logging it instead", {
      to: mail.to,
      subject: mail.subject,
      body: mail.text,
    });
    return;
  }
  await transporter().sendMail({
    from: process.env.SMTP_FROM ?? "SnapCrawl <no-reply@snapcrawl.dev>",
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
}

/** Account-locked notice (FR-BE-007). This is the ONLY channel that tells the
 *  user their account is locked: the login response deliberately stays a generic
 *  401, because a distinguishable "locked" answer would confirm to an attacker
 *  that the address exists and that they are making progress. */
export function accountLockedMail(to: string, minutes: number, ip: string | null): Mail {
  return {
    to,
    subject: "Your SnapCrawl account is temporarily locked",
    text: [
      `Your SnapCrawl account has been locked for ${minutes} minutes after too many`,
      "failed sign-in attempts.",
      "",
      ...(ip ? [`Most recent attempt came from: ${ip}`, ""] : []),
      "If this was you, wait and try again — or reset your password:",
      `${process.env.WEB_ORIGIN ?? "http://localhost:3000"}/forgot-password`,
      "",
      "If it wasn't you, someone is guessing your password. Your account is safe for",
      "now, but reset it to be sure.",
    ].join("\n"),
  };
}

/** Verify-your-email message (FR-BE-008). The link points at the panel's verify
 *  page, which posts the token back to POST /auth/verify-email. */
export function verifyEmailMail(to: string, rawToken: string, ttlMin: number): Mail {
  const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const link = `${base}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const hours = Math.round(ttlMin / 60);
  return {
    to,
    subject: "Confirm your SnapCrawl email",
    text: [
      "Welcome to SnapCrawl. Confirm this email address to activate your account:",
      "",
      `${link}`,
      "",
      `The link works once and expires in ${hours} hour${hours === 1 ? "" : "s"}.`,
      "",
      "If you didn't create a SnapCrawl account, you can ignore this email.",
    ].join("\n"),
  };
}

/** Reset-my-password message (FR-BE-005). The link points at the panel's
 *  reset page (FR-AP-003), which posts the token back to the API. */
export function passwordResetMail(to: string, rawToken: string, ttlMin: number): Mail {
  const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const link = `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
  return {
    to,
    subject: "Reset your SnapCrawl password",
    text: [
      "Someone asked to reset the password for this SnapCrawl account.",
      "",
      `Reset it here (the link works once, and expires in ${ttlMin} minutes):`,
      link,
      "",
      "If this wasn't you, ignore this email — your password has not changed.",
    ].join("\n"),
  };
}
