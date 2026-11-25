// Checks Wokingham library loans once a day and emails when any are near their
// due date. Runs as a long-lived container: a daily timer does the check, and a
// small HTTP server exposes /healthz, the last result, and a manual trigger.
//
// It has to run from a home connection: the library site sits behind AWS WAF,
// which answers datacenter IPs (Cloudflare Workers included) with a CAPTCHA.

import { createServer } from "node:http";

// SPYDUS_BASE_URL is only for testing against a local mock of the site.
const BASE_URL = process.env.SPYDUS_BASE_URL || "https://wokingham.spydus.co.uk";
const LOGIN_PATH = "/cgi-bin/spydus.exe/PGM/WPAC/CCOPT/LB/2";
// The WPAC dashboard now redirects to the catalogue home page, so use the
// OPAC one that the account menu links to as "Dashboard".
const DASHBOARD_PATH = "/cgi-bin/spydus.exe/PGM/OPAC/CCOPT/LB/1?ISGLB=0";
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
  // A failed check is retried with a fresh login, waiting RETRY_DELAY_SECONDS
  // before the second attempt and doubling the wait each time after that.
  retryAttempts: Math.max(1, Number(env("RETRY_ATTEMPTS", "3"))),
  retryDelayMs: Number(env("RETRY_DELAY_SECONDS", "30")) * 1000,
};
const VERSION = process.env.APP_VERSION || "dev";
const REPO_URL = "https://github.com/jasoncabot/library-monitor";
const REQUEST_TIMEOUT_MS = 30_000;
config.emailFrom = env("EMAIL_FROM", `Library Monitor <library-monitor@${config.mailgunDomain}>`);

// Lines logged during the current run, kept for the failure report.
let runLog = null;

const log = (message, fields = {}) => {
  const line = redact(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
  runLog?.push(line);
  console.log(line);
};

// Keeps the card number and PIN out of logs and failure reports.
function redact(text) {
  let out = String(text);
  const { borrowerId, password } = config;
  if (borrowerId.length >= 4) out = out.replaceAll(borrowerId, "[BORROWER_ID]");
  out = out.replace(/(BRWLPWD["']?\s*[=:]\s*["']?)[^&"'\s>]*/gi, "$1[REDACTED]");
  // A 4 digit PIN would also match dates and IDs, so only exact attribute values are replaced.
  out = out.replaceAll(`value="${password}"`, 'value="[REDACTED]"');
  if (password.length >= 6) out = out.replaceAll(password, "[REDACTED]");
  return out;
}

// retryable is false for failures another attempt can't fix, such as a
// rejected PIN, where retrying could also lock the account.
class SpydusError extends Error {
  name = "SpydusError";
  constructor(message, { retryable = true, ...options } = {}) {
    super(message, options);
    this.retryable = retryable;
  }
}

// --- Fetching -------------------------------------------------------------

// Spydus keeps the login in cookies and the AWS load balancer adds stickiness
// cookies, so every response's cookies are kept and replayed.
class Session {
  cookies = new Map();
  // Every request made, and the last HTML page received, for the failure report.
  trace = [];
  lastPage = null;

  store(response) {
    const names = [];
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((a) => /^\s*expires=.*1970/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
      names.push(expired || !value ? `-${name}` : name);
    }
    return names;
  }

  record(entry) {
    this.trace.push(entry);
    log("HTTP", entry);
  }

  async get(url, init = {}) {
    // Follow redirects by hand so cookies set along the way are kept.
    for (let hop = 0; hop < 8; hop++) {
      const headers = new Headers(init.headers);
      headers.set("user-agent", USER_AGENT);
      headers.set("accept", "text/html,application/xhtml+xml");
      if (this.cookies.size) {
        headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      }

      const method = init.method ?? "GET";
      const started = Date.now();
      const entry = { method, url, cookiesSent: [...this.cookies.keys()] };
      let response;
      let html;
      try {
        response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        entry.status = response.status;
        entry.cookiesSet = this.store(response);
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          this.record({ ...entry, ms: Date.now() - started, location });
          url = new URL(location, url).toString();
          init = {};
          continue;
        }
        html = await response.text();
      } catch (error) {
        const reason = error.name === "TimeoutError" ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (error.cause?.message ?? error.message);
        this.record({ ...entry, ms: Date.now() - started, error: reason });
        throw new SpydusError(`${method} ${url} failed: ${reason}`, { cause: error });
      }

      const wafAction = response.headers.get("x-amzn-waf-action");
      // After login Spydus answers with a tiny page that redirects to the
      // account dashboard, so follow those like an HTTP redirect.
      const [target] = response.ok && html.length < 2000 ? pageRedirects(html) : [];
      this.lastPage = { url, status: response.status, contentType: response.headers.get("content-type"), html };
      this.record({
        ...entry,
        ms: Date.now() - started,
        bytes: html.length,
        title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || undefined,
        wafAction: wafAction ?? undefined,
        pageRedirect: target,
      });

      if (wafAction) throw new SpydusError(`${url} was blocked by AWS WAF (${wafAction}, status ${response.status})`);
      if (!response.ok) throw new SpydusError(`${method} ${url} returned ${response.status}`);
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

// Loan pages are linked from the dashboard tiles (a.brw-dashboard-item) and,
// on every signed-in page, from the account menu's "Current loans" item, an
// ENQ/<interface>/LOANRENQ link. Use the tiles if present, else the menu link.
const loanUrls = (html) => {
  const tags = [...html.matchAll(/<a\b[^>]*>/gi)].map(([tag]) => tag);
  const hrefs = (keep) =>
    [...new Set(tags.filter(keep).map((tag) => attribute(tag, "href")).filter(Boolean))].map((href) =>
      new URL(decode(href), BASE_URL).toString()
    );
  const tiles = hrefs((tag) => /\bbrw-dashboard-item\b/.test(attribute(tag, "class") ?? ""));
  return tiles.length ? tiles : hrefs((tag) => /\/ENQ\/\w+\/LOANRENQ\//i.test(attribute(tag, "href") ?? ""));
};

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

const showsLoginForm = (html) => /id\s*=\s*["']frmLogin["']/.test(html);

async function fetchLoans(session) {
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
    throw new SpydusError("Login rejected: Invalid ID or password. Check BORROWER_ID and BORROWER_PASSWORD (a 4 digit PIN).", {
      retryable: false,
    });
  }

  // A successful login normally lands on the account dashboard. If it lands
  // somewhere else, load the dashboard directly before giving up.
  let dashboard = loginHtml;
  let urls = loanUrls(dashboard);
  if (urls.length === 0 && !showsLoginForm(dashboard)) {
    log("No loan links on the page after login, loading the dashboard", describe(dashboard));
    dashboard = await session.get(BASE_URL + DASHBOARD_PATH);
    urls = loanUrls(dashboard);
  }
  log("Found loan pages", { count: urls.length });
  if (urls.length === 0) {
    // Every account dashboard links to its loans, so none means the page has
    // changed. Describe it so the parser can be fixed from the logs.
    log("Dashboard", { cookies: [...session.cookies.keys()], ...describe(dashboard) });
    throw new SpydusError(
      showsLoginForm(dashboard)
        ? "Dashboard showed the login form, so the login was not kept"
        : "Found no loan links on the dashboard; the page layout may have changed (see logs)"
    );
  }

  const loans = [];
  for (const url of urls) {
    const page = await session.get(url);
    const found = books(page);
    log("Read loan page", { url, books: found.length });
    if (found.length === 0) log("Loan page had no books", describe(page));
    loans.push(...found);
  }
  return loans;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each attempt logs in again with a fresh session. The error from the last
// attempt carries its session and attempt count for the failure report.
async function fetchLoansWithRetries() {
  for (let attempt = 1; ; attempt++) {
    const session = new Session();
    try {
      log("Attempt", { attempt, of: config.retryAttempts });
      return await fetchLoans(session);
    } catch (error) {
      error.session = session;
      error.attempts = attempt;
      const willRetry = error.retryable !== false && attempt < config.retryAttempts;
      const delayMs = config.retryDelayMs * 2 ** (attempt - 1);
      log("Attempt failed", { attempt, error: error.message, retrying: willRetry ? `in ${delayMs / 1000}s` : false });
      if (!willRetry) throw error;
      await sleep(delayMs);
    }
  }
}

// --- Failure reports ------------------------------------------------------

// The page with scripts, styles and head boilerplate cut down, so the part
// that matters to the parser fits in an email.
function pageExcerpt(html, limit) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, (head) => {
      const keep = [...head.matchAll(/<title[^>]*>[\s\S]*?<\/title>|<meta\b[^>]*refresh[^>]*>/gi)].map((m) => m[0]);
      return `<head>${keep.join("")}</head>`;
    })
    .replace(/<(script|style|svg|noscript)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag, attrs, body) =>
      tag.toLowerCase() === "script" && body.length <= 400 ? whole : `<${tag}${attrs}>[${body.length} chars removed]</${tag}>`
    )
    .replace(/(["'])data:[^"']{60,}\1/gi, '"data:..."')
    .replace(/>\s+</g, ">\n<")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return cleaned.length > limit
    ? `${cleaned.slice(0, limit)}\n... [truncated, ${cleaned.length - limit} more characters]`
    : cleaned;
}

// A plain-text report with everything needed to understand a failure: paste
// it into Claude along with monitor.mjs.
function failureReport({ error, startedAt, pageLimit }) {
  const session = error.session;
  const causes = [];
  for (let e = error.cause; e && causes.length < 5; e = e.cause) causes.push(`${e.name ?? "Error"}: ${e.message}${e.code ? ` (${e.code})` : ""}`);

  const requests = (session?.trace ?? []).map((r, i) => {
    const target = r.location ? ` -> ${r.location}` : r.pageRedirect ? ` -> (page redirect) ${r.pageRedirect}` : "";
    const outcome = r.error ? `FAILED: ${r.error}` : `${r.status}${r.bytes !== undefined ? `, ${r.bytes} bytes` : ""}`;
    const extras = [
      r.title && `title "${r.title}"`,
      r.wafAction && `WAF ${r.wafAction}`,
      `cookies sent [${r.cookiesSent.join(", ")}]`,
      r.cookiesSet?.length && `set [${r.cookiesSet.join(", ")}]`,
    ].filter(Boolean);
    return `${i + 1}. ${r.method} ${r.url}\n   ${outcome} in ${r.ms} ms${target}\n   ${extras.join("; ")}`;
  });

  const page = session?.lastPage;
  const sections = [
    "# Library Monitor failure report",
    "",
    `This is a failure report from Library Monitor (${REPO_URL}), which logs into the Wokingham Spydus library catalogue with a plain fetch-based scraper (monitor.mjs) and emails when loans are due. Please explain what went wrong and, if the scraper needs changing, suggest a fix to monitor.mjs. The card number and PIN have been replaced with [BORROWER_ID] and [REDACTED].`,
    "",
    "## Summary",
    `- Error: ${error.message}`,
    `- Error type: ${error.name}${error.retryable === false ? " (not retried)" : ""}`,
    `- Attempts: ${error.attempts ?? 1} of ${config.retryAttempts} (fresh login each time, first retry after ${config.retryDelayMs / 1000}s, doubling)`,
    `- Run started: ${startedAt}`,
    `- Report created: ${new Date().toISOString()}`,
    `- Version: ${VERSION}`,
    `- Runtime: Node ${process.version} on ${process.platform}/${process.arch}, TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    "",
    "## Error",
    "```",
    error.stack ?? String(error),
    ...causes.map((c) => `Caused by ${c}`),
    "```",
    "",
    "## HTTP requests in the last attempt",
    requests.length ? requests.join("\n") : "(none were made)",
    "",
    "## Log for this run",
    "```",
    ...(runLog ?? []),
    "```",
  ];
  if (page) {
    sections.push(
      "",
      "## Last page received",
      `- URL: ${page.url}`,
      `- Status: ${page.status}, content type ${page.contentType ?? "unknown"}, ${page.html.length} bytes`,
      "",
      "Structure:",
      "```json",
      JSON.stringify(describe(page.html), null, 2),
      "```",
      "",
      "HTML (scripts, styles and head trimmed):",
      "```html",
      pageExcerpt(page.html, pageLimit),
      "```"
    );
  }
  return redact(sections.join("\n"));
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

function failureEmail(message, { inlineReport, fullReport }) {
  const intro = "Today's library check failed, so books coming up to their due date may not have been reported.";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  // <details> collapses the report in Apple Mail, iOS Mail and Thunderbird;
  // clients that don't support it (Gmail) show it expanded.
  const html = layout({
    preheader: message,
    heading: "Library check failed",
    intro: escapeHtml(intro),
    content: `<div style="padding:14px 16px;border-radius:8px;background:#fef3f2;border:1px solid #fecdca;font-family:${mono};font-size:13px;line-height:1.5;color:#b42318;word-break:break-word;">${escapeHtml(message)}</div>
<p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#52606d;">Check your loans on the library website until this is fixed.</p>
<details style="margin:16px 0 0;border:1px solid #e4e7eb;border-radius:8px;">
<summary style="padding:12px 16px;cursor:pointer;font-size:14px;font-weight:600;color:#1f2933;">Diagnostic report</summary>
<div style="padding:0 16px 16px;">
<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#52606d;">Copy this into Claude to find out what went wrong. The attached <b>library-monitor-report.txt</b> has the same report with more of the page.</p>
<pre style="margin:0;padding:12px;background:#f5f7fa;border-radius:6px;font-family:${mono};font-size:11px;line-height:1.45;color:#323f4b;white-space:pre-wrap;word-break:break-word;">${escapeHtml(inlineReport)}</pre>
</div>
</details>`,
    button: { label: "Log in to the library", href: LOGIN_URL },
  });
  return {
    subject: "Library Monitor failed",
    text: `${intro}\n\n${message}\n\nLog in: ${LOGIN_URL}\n\n----- Diagnostic report (copy into Claude) -----\n\n${inlineReport}`,
    html,
    attachments: [{ filename: "library-monitor-report.txt", type: "text/plain", content: fullReport }],
  };
}

async function sendEmail(to, { subject, text, html, attachments = [] }) {
  if (dryRun) {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const preview = join(tmpdir(), "library-monitor-email.html");
    writeFileSync(preview, html);
    const files = attachments.map((a) => {
      const path = join(tmpdir(), a.filename);
      writeFileSync(path, a.content);
      return path;
    });
    // Printed rather than logged so the run log doesn't contain itself.
    return console.log(JSON.stringify({ message: "Dry run, not sending email", to, subject, preview, attachments: files }));
  }

  const form = new FormData();
  for (const [key, value] of Object.entries({ from: config.emailFrom, subject, text, html })) form.append(key, value);
  for (const address of to) form.append("to", address);
  for (const a of attachments) form.append("attachment", new Blob([a.content], { type: a.type }), a.filename);

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
  const loans = await fetchLoansWithRetries();
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
let lastReport = null;
let running = null;

// Runs the check and, if it fails, emails the first recipient so a broken
// scraper doesn't look the same as "nothing due".
async function run(alwaysSend = false) {
  const startedAt = new Date().toISOString();
  runLog = [];
  try {
    const result = await check(alwaysSend);
    lastRun = { startedAt, ok: true, ...result };
  } catch (error) {
    log("Library check failed", { error: error.message });
    lastRun = { startedAt, ok: false, error: error.message, attempts: error.attempts, report: "/report" };
    try {
      // The email keeps a shorter page excerpt so Gmail doesn't clip it.
      lastReport = failureReport({ error, startedAt, pageLimit: 60_000 });
      const inlineReport = failureReport({ error, startedAt, pageLimit: 12_000 });
      await sendEmail(config.emailTo.slice(0, 1), failureEmail(redact(error.message), { inlineReport, fullReport: lastReport }));
    } catch (alertError) {
      log("Failed to send failure alert", { error: alertError.message });
    }
  } finally {
    runLog = null;
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
  if (url.pathname === "/report" && req.method === "GET") {
    res.writeHead(lastReport ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
    return res.end(lastReport ?? "No failure since the container started.\n");
  }
  // POST so a crawler or link preview can't trigger emails.
  if (url.pathname === "/run" && req.method === "POST") {
    return json(200, await runOnce(url.searchParams.get("alwaysSend") === "true"));
  }
  json(404, { error: "not found" });
}).listen(config.listenPort, () => log("Listening", { port: config.listenPort }));

schedule();
