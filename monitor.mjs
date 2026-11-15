// Checks Wokingham library loans once a day and emails when any are near their
// due date. Runs as a long-lived container: a daily timer does the check, and a
// small HTTP server exposes /healthz, the last result, and a manual trigger.
//
// It has to run from a home connection: the library site sits behind AWS WAF,
// which answers datacenter IPs (Cloudflare Workers included) with a CAPTCHA.

import { createServer } from "node:http";

const BASE_URL = "https://wokingham.spydus.co.uk";
const LOGIN_PATH = "/cgi-bin/spydus.exe/PGM/WPAC/CCOPT/LB/2";
const DASHBOARD_PATH = "/cgi-bin/spydus.exe/PGM/WPAC/CCOPT/LB/1?ISGLB=0";
const USER_AGENT =
  "Mozilla/5.0 (compatible; library-monitor/3.0; +https://github.com/jasoncabot/library-monitor)";

// --dry-run logs emails instead of sending them, so Mailgun isn't needed.
const dryRun = process.argv.includes("--dry-run");

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} must be set`);
  return value;
};

const config = {
  borrowerId: env("BORROWER_ID"),
  password: env("BORROWER_PASSWORD"),
  emailTo: env("EMAIL_TO").split(/[,;]/).map((a) => a.trim()).filter(Boolean),
  mailgunApiKey: env("MAILGUN_API_KEY", dryRun ? "-" : undefined),
  mailgunDomain: env("MAILGUN_DOMAIN", dryRun ? "example.com" : undefined),
  // https://api.eu.mailgun.net for domains in Mailgun's EU region.
  mailgunBaseUrl: env("MAILGUN_BASE_URL", "https://api.mailgun.net"),
  checkTime: env("CHECK_TIME", "06:00"),
  notifyWithinMs: Number(env("NOTIFY_WITHIN_DAYS", "2")) * 24 * 60 * 60 * 1000,
  listenPort: Number(env("LISTEN_PORT", "8080")),
};
config.emailFrom = env("EMAIL_FROM", `Library Monitor <library-monitor@${config.mailgunDomain}>`);

const log = (message, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

class SpydusError extends Error {
  name = "SpydusError";
}

// --- Fetching -------------------------------------------------------------

// Spydus keeps the login in cookies and the AWS load balancer adds stickiness
// cookies, so every response's cookies are kept and replayed.
class Session {
  cookies = new Map();

  store(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /^\s*expires=.*1970/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(url, init = {}) {
    // Follow redirects by hand so cookies set along the way are kept.
    for (let hop = 0; hop < 5; hop++) {
      const headers = new Headers(init.headers);
      headers.set("user-agent", USER_AGENT);
      headers.set("accept", "text/html,application/xhtml+xml");
      if (this.cookies.size) {
        headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      }

      const response = await fetch(url, { ...init, headers, redirect: "manual" });
      this.store(response);

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url).toString();
        init = {};
        continue;
      }

      const wafAction = response.headers.get("x-amzn-waf-action");
      if (wafAction) {
        await response.body?.cancel();
        throw new SpydusError(`${url} was blocked by AWS WAF (${wafAction}, status ${response.status})`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SpydusError(`${url} returned ${response.status}`);
      }
      const html = await response.text();

      // After login Spydus answers with a tiny page that redirects to the
      // account dashboard, so follow those like an HTTP redirect.
      const [target] = html.length < 2000 ? pageRedirects(html) : [];
      if (target) {
        url = new URL(target, url).toString();
        init = {};
        continue;
      }
      return html;
    }
    throw new SpydusError(`Too many redirects fetching ${url}`);
  }
}

// --- Parsing --------------------------------------------------------------

const decode = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const attribute = (tag, name) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"))?.slice(1).find((v) => v !== undefined);

const loanUrls = (html) =>
  [...html.matchAll(/<a\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /\bbrw-dashboard-item\b/.test(attribute(tag, "class") ?? ""))
    .map((tag) => attribute(tag, "href"))
    .filter(Boolean)
    .map((href) => new URL(decode(href), BASE_URL).toString());

// Each loan on the page starts with a hidden <input name="SVL"> and is followed
// by its title (h2.card-title) and a table with Due and Status cells.
const books = (html) => {
  const starts = [...html.matchAll(/<input\b[^>]*\bname\s*=\s*["']SVL["'][^>]*>/gi)];
  return starts.map((match, i) => {
    const chunk = html.slice(match.index, starts[i + 1]?.index ?? html.length);
    const field = (pattern) => decode(chunk.match(pattern)?.[1] ?? "");
    return {
      id: attribute(match[0], "value") ?? null,
      title: field(/<h2\b[^>]*class\s*=\s*["'][^"']*\bcard-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i),
      due: field(/<td\b[^>]*data-caption\s*=\s*["']Due["'][^>]*>([\s\S]*?)<\/td>/i),
      status: field(/<td\b[^>]*data-caption\s*=\s*["']Status["'][^>]*>([\s\S]*?)<\/td>/i),
    };
  });
};

// Targets of <meta http-equiv="refresh"> tags and script location changes.
const pageRedirects = (html) =>
  [...html.matchAll(/(?:location(?:\.href)?\s*=|location\.replace\(|http-equiv\s*=\s*["']?refresh["']?[^>]*url\s*=)\s*["']?([^"')\s>]+)/gi)].map((m) =>
    decode(m[1])
  );

// A structural summary of a page for diagnosing parser failures. Query strings
// are dropped so session and account identifiers don't end up in logs.
const describe = (html) => {
  const path = (href) => decode(href).split(/[?#]/)[0];
  const links = new Map();
  for (const [tag] of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attribute(tag, "href");
    if (!href || !/spydus\.exe/i.test(href)) continue;
    const key = path(href);
    if (!links.has(key)) links.set(key, attribute(tag, "class") ?? "");
  }
  return {
    bytes: html.length,
    title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    headings: [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => decode(m[1])).slice(0, 10),
    redirects: pageRedirects(html).map(path),
    links: [...links].slice(0, 40).map(([href, cls]) => (cls ? `${href} .${cls.trim().split(/\s+/).join(".")}` : href)),
  };
};

// --- Checking -------------------------------------------------------------

async function fetchLoans() {
  const session = new Session();

  log("Logging in", { borrowerId: config.borrowerId.slice(-4).padStart(config.borrowerId.length, "*") });
  const loginHtml = await session.get(BASE_URL + LOGIN_PATH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ BRWLID: config.borrowerId, BRWLPWD: config.password, RDT: DASHBOARD_PATH }),
  });
  if (/awswaf\.com|AwsWafIntegration/i.test(loginHtml)) {
    throw new SpydusError("Login was blocked by an AWS WAF challenge");
  }
  if (/Invalid ID or password/i.test(loginHtml)) {
    throw new SpydusError("Login rejected: Invalid ID or password. Check BORROWER_ID and BORROWER_PASSWORD (a 4 digit PIN).");
  }

  // A successful login lands on the account dashboard.
  const dashboard = loginHtml;
  const urls = loanUrls(dashboard);
  log("Found loan pages", { count: urls.length });
  if (urls.length === 0) {
    // Every account dashboard links to its loans, so none means the page has
    // changed. Describe it so the parser can be fixed from the logs.
    log("Dashboard", { cookies: [...session.cookies.keys()], ...describe(dashboard) });
    throw new SpydusError(
      /id\s*=\s*["']frmLogin["']/.test(dashboard)
        ? "Dashboard showed the login form, so the login was not kept"
        : "Found no loan links on the dashboard; the page layout may have changed (see logs)"
    );
  }

  const loans = [];
  for (const url of urls) loans.push(...books(await session.get(url)));
  return loans;
}

// --- Emails ---------------------------------------------------------------

const LOGIN_URL = `${BASE_URL}/cgi-bin/spydus.exe/MSGTRN/WPAC/LOGINB`;
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const formatDate = (date) =>
  date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

// Whole calendar days from today until the due date, in the container's TZ.
function daysUntil(due, now = new Date()) {
  const dueAt = new Date(Date.parse(due));
  if (Number.isNaN(dueAt.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(dueAt.getFullYear(), dueAt.getMonth(), dueAt.getDate());
  return Math.round((dueDay - today) / DAY_MS);
}

function dueBadge(days) {
  const red = { color: "#b42318", background: "#fef3f2" };
  const amber = { color: "#b54708", background: "#fffaeb" };
  const green = { color: "#067647", background: "#ecfdf3" };
  if (days === null) return { label: "Check due date", ...amber };
  if (days < 0) return { label: `Overdue by ${-days} ${-days === 1 ? "day" : "days"}`, ...red };
  if (days === 0) return { label: "Due today", ...red };
  if (days === 1) return { label: "Due tomorrow", ...amber };
  if (days <= 3) return { label: `Due in ${days} days`, ...amber };
  return { label: `Due in ${days} days`, ...green };
}

// Table layout and inline styles, because that's what email clients render reliably.
function layout({ preheader, heading, intro, content, button }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2933;">
<tr><td style="background:#1f4d3f;padding:20px 28px;">
<div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#cfe3d8;">Library Monitor</div>
<div style="font-size:15px;color:#ffffff;margin-top:2px;">Your Wokingham library loans</div>
</td></tr>
<tr><td style="padding:28px 28px 8px;">
<h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#1f2933;">${escapeHtml(heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.5;color:#52606d;">${intro}</p>
</td></tr>
<tr><td style="padding:16px 28px 8px;">${content}</td></tr>
<tr><td style="padding:16px 28px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#1f4d3f;">
<a href="${button.href}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
</td></tr></table>
</td></tr>
</table>
<p style="margin:16px 0 0;font-size:12px;color:#7b8794;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Sent by your Library Monitor, which checks your loans every morning.</p>
</td></tr>
</table>
</body>
</html>`;
}

function loansEmail(notify) {
  const books = notify
    .map((book) => ({ ...book, days: daysUntil(book.due) }))
    .sort((a, b) => (a.days ?? -Infinity) - (b.days ?? -Infinity));
  const n = books.length;
  const plural = n === 1 ? "book" : "books";
  const overdue = books.filter((b) => b.days !== null && b.days < 0).length;
  const due = books[books.length - 1];
  const latest = due.days === null ? "soon" : due.days === 0 ? "today" : due.days === 1 ? "tomorrow" : `by ${formatDate(new Date(Date.parse(due.due)))}`;
  // e.g. "3 books due by Mon 7 Dec", "2 books overdue", "4 books due, 1 overdue"
  const headline = (noun) =>
    overdue === n ? `${n} ${noun} overdue` : overdue > 0 ? `${n} ${noun} due, ${overdue} overdue` : `${n} ${noun} due ${latest}`;
  const subject = headline(`library ${plural}`);

  const cards = books
    .map((book) => {
      const badge = dueBadge(book.days);
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #e4e7eb;border-left:4px solid ${badge.color};border-radius:8px;">
<tr><td style="padding:14px 16px;">
<div style="font-size:16px;font-weight:600;line-height:1.4;color:#1f2933;">${escapeHtml(book.title || "Untitled")}</div>
<div style="margin-top:8px;">
<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:600;color:${badge.color};background:${badge.background};">${escapeHtml(badge.label)}</span>
<span style="font-size:13px;color:#52606d;margin-left:8px;">${escapeHtml(book.due)}</span>
</div>
${book.status ? `<div style="margin-top:6px;font-size:13px;color:#7b8794;">${escapeHtml(book.status)}</div>` : ""}
</td></tr></table>`;
    })
    .join("\n");

  const intro =
    (overdue > 0
      ? n === 1 ? "This book is overdue." : `${overdue === n ? "These books are" : `${overdue} of these books ${overdue === 1 ? "is" : "are"}`} overdue.`
      : n === 1 ? "This book is coming up to its due date." : `These ${n} books are coming up to their due dates.`) +
    ` Renew ${n === 1 ? "it" : "them"} online or return ${n === 1 ? "it" : "them"} to avoid ${overdue > 0 ? "further fines" : "a fine"}.`;
  const html = layout({
    preheader: books.map((b) => b.title).join(", "),
    heading: headline(plural),
    intro: escapeHtml(intro),
    content: cards,
    button: { label: "Log in to renew", href: LOGIN_URL },
  });
  const text = [
    intro,
    "",
    ...books.map((b) => `* ${b.title}: ${dueBadge(b.days).label.toLowerCase()} (${b.due}). ${b.status}`.trim()),
    "",
    `Log in to renew: ${LOGIN_URL}`,
  ].join("\n");
  return { subject, text, html };
}

function failureEmail(message) {
  const intro = "Today's library check failed, so books coming up to their due date may not have been reported.";
  const html = layout({
    preheader: message,
    heading: "Library check failed",
    intro: escapeHtml(intro),
    content: `<div style="padding:14px 16px;border-radius:8px;background:#fef3f2;border:1px solid #fecdca;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;color:#b42318;word-break:break-word;">${escapeHtml(message)}</div>
<p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#52606d;">Check your loans on the library website until this is fixed.</p>`,
    button: { label: "Log in to the library", href: LOGIN_URL },
  });
  return { subject: "Library Monitor failed", text: `${intro}\n\n${message}\n\nLog in: ${LOGIN_URL}`, html };
}

async function sendEmail(to, { subject, text, html }) {
  if (dryRun) {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const preview = join(tmpdir(), "library-monitor-email.html");
    writeFileSync(preview, html);
    return log("Dry run, not sending email", { to, subject, text, preview });
  }

  const form = new URLSearchParams({ from: config.emailFrom, subject, text, html });
  for (const address of to) form.append("to", address);

  const response = await fetch(`${config.mailgunBaseUrl}/v3/${config.mailgunDomain}/messages`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`api:${config.mailgunApiKey}`).toString("base64")}` },
    body: form,
  });
  const raw = await response.text();
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  if (!response.ok) {
    const reason = (body.message ?? raw).trim().slice(0, 200);
    throw new Error(`Email send failed with ${response.status}${reason ? ` (${reason})` : ""}`);
  }
  log("Sent email", { subject, recipients: to.length, id: body.id });
}

async function check(alwaysSend) {
  const loans = await fetchLoans();
  const now = Date.now();
  const notify = loans.filter((book) => {
    log("Book on loan", book);
    const dueAt = Date.parse(book.due);
    // An unparseable date is reported rather than silently dropped.
    return alwaysSend || Number.isNaN(dueAt) || dueAt - now < config.notifyWithinMs;
  });
  log("Checked loans", { onLoan: loans.length, notify: notify.length });

  if (notify.length > 0) await sendEmail(config.emailTo, loansEmail(notify));
  return { loans, notify, emailed: notify.length > 0 };
}

let lastRun = null;
let running = null;

// Runs the check and, if it fails, emails the first recipient so a broken
// scraper doesn't look the same as "nothing due".
async function run(alwaysSend = false) {
  const startedAt = new Date().toISOString();
  try {
    const result = await check(alwaysSend);
    lastRun = { startedAt, ok: true, ...result };
  } catch (error) {
    log("Library check failed", { error: error.message });
    lastRun = { startedAt, ok: false, error: error.message };
    try {
      await sendEmail(config.emailTo.slice(0, 1), failureEmail(error.message));
    } catch (alertError) {
      log("Failed to send failure alert", { error: alertError.message });
    }
  }
  return lastRun;
}

const runOnce = (alwaysSend) => (running ??= run(alwaysSend).finally(() => (running = null)));

// --- Scheduling and HTTP ---------------------------------------------------

// The next CHECK_TIME in the container's TZ. Using local-time setters keeps the
// wall-clock time steady across daylight saving changes.
function nextCheck(from = new Date()) {
  const [hours, minutes] = config.checkTime.split(":").map(Number);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

function schedule() {
  const at = nextCheck();
  log("Next check scheduled", { at: at.toString() });
  setTimeout(async () => {
    await runOnce(false);
    schedule();
  }, at - Date.now());
}

if (process.argv.includes("--once")) {
  const result = await run(process.argv.includes("--always-send"));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };

  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/" && req.method === "GET") return json(200, { nextCheck: nextCheck().toString(), lastRun });
  // POST so a crawler or link preview can't trigger emails.
  if (url.pathname === "/run" && req.method === "POST") {
    return json(200, await runOnce(url.searchParams.get("alwaysSend") === "true"));
  }
  json(404, { error: "not found" });
}).listen(config.listenPort, () => log("Listening", { port: config.listenPort }));

schedule();
