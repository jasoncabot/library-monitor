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

async function sendEmail(to, subject, text) {
  if (dryRun) return log("Dry run, not sending email", { to, subject, text });

  const form = new URLSearchParams({ from: config.emailFrom, subject, text });
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

  if (notify.length > 0) {
    const text = notify.map((b) => `* ${b.title} is due ${b.due} and has status: ${b.status}.`).join("\n");
    await sendEmail(config.emailTo, `${notify.length} ${notify.length === 1 ? "book" : "books"} near renewal date`, text);
  }
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
      await sendEmail(
        config.emailTo.slice(0, 1),
        "Library Monitor failed",
        `The daily library check failed, so overdue books may not have been reported.\n\n${error.message}`
      );
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
