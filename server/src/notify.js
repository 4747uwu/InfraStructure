import nodemailer from 'nodemailer';
import { getSettings } from './db.js';

// Outbound alert channels. Both are optional and configured by the master under Settings.

export async function sendEmail(cfg, subject, text) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure, // true for port 465; false upgrades with STARTTLS where offered
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  await transport.sendMail({ from: cfg.from || cfg.user, to: cfg.to.join(', '), subject, text });
}

export async function sendTelegram(cfg, text) {
  // Overridable so tests can point it at a local stand-in.
  const api = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const res = await fetch(`${api}/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Telegram refused the message (${res.status}${body.description ? `: ${body.description}` : ''})`);
  }
}

// Sends to every enabled channel. Never throws: returns { channel: 'sent' | error message }.
export async function notify(subject, text) {
  const n = (await getSettings())?.notifications || {};
  const jobs = [];
  if (n.email?.enabled) {
    jobs.push(sendEmail(n.email, subject, text).then(() => ['email', 'sent'], (e) => ['email', e.message]));
  }
  if (n.telegram?.enabled) {
    jobs.push(sendTelegram(n.telegram, `${subject}\n\n${text}`).then(() => ['telegram', 'sent'], (e) => ['telegram', e.message]));
  }
  const results = Object.fromEntries(await Promise.all(jobs));
  for (const [channel, result] of Object.entries(results)) {
    if (result !== 'sent') console.error(`  Alert notification by ${channel} failed: ${result}`);
  }
  return results;
}
