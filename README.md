# Wokingham Library Loan Monitor

Wokingham library doesn't let you know when your books are near their renewal date. This does.

Once a day it logs into the Wokingham Spydus catalogue, reads your current loans, and emails you if any are due within two days. If the check itself fails (the login is rejected, the site changes, it gets blocked), it emails the first recipient instead, so a broken check doesn't look the same as "nothing due".

- One JavaScript file, no dependencies, runs on Node 24.
- Email goes out through the [Mailgun](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages) API.
- It has to run from a home connection. The library site is behind AWS WAF, which shows a CAPTCHA to datacenter IPs. That's why this stopped working as a Cloudflare Worker.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `BORROWER_ID` | – | Library card number (required) |
| `BORROWER_PASSWORD` | – | 4 digit PIN (required) |
| `EMAIL_TO` | – | Comma separated recipients; failure alerts only go to the first (required) |
| `MAILGUN_API_KEY` | – | Mailgun sending API key (required) |
| `MAILGUN_DOMAIN` | – | Your sending domain in Mailgun (required) |
| `MAILGUN_BASE_URL` | `https://api.mailgun.net` | Use `https://api.eu.mailgun.net` for an EU-region domain |
| `EMAIL_FROM` | `Library Monitor <library-monitor@MAILGUN_DOMAIN>` | Sender |
| `CHECK_TIME` | `06:00` | Daily check time, in `TZ` |
| `TZ` | `Europe/London` | Timezone for `CHECK_TIME` |
| `NOTIFY_WITHIN_DAYS` | `2` | Email when a book is due within this many days |
| `LISTEN_PORT` | `8080` | Port for the HTTP endpoints |

## Running

```sh
cp .env.example .env   # .env is gitignored; fill it in
docker compose up -d --build
curl -X POST 'localhost:8080/run?alwaysSend=true'   # check now and email whatever is on loan
```

Or without Docker, for a single check:

```sh
set -a; . ./.env; set +a
node monitor.mjs --once                # add --always-send to email every loan
```

## Endpoints

- `GET /healthz`: liveness probe used by the compose healthcheck
- `GET /`: the next scheduled check and the last result as JSON
- `POST /run`: check now; `?alwaysSend=true` emails every loan, not just those due soon

## Deploying to the NAS

`.github/workflows/build.yml` builds the image and pushes it to the GitHub Container Registry:

| Push | Image tags |
| --- | --- |
| to `main` | `:main`, `:sha-<commit>` |
| a tag like `v1.2.3` | `:1.2.3`, `:1.2`, `:latest`, `:sha-<commit>` |

To cut a release: `git tag v1.2.3 && git push origin v1.2.3`.

`deploy.yaml` is the TrueNAS stack definition. It pulls `ghcr.io/jasoncabot/library-monitor:latest` and reads the credentials and Mailgun settings from the stack's own environment, so none of them live in git. The container runs with a read-only filesystem as a non-root user, with all capabilities dropped, and keeps no state on disk. It's published on port `30106`.

While the repository is private, its container package is private too. Either make the package public (it contains no credentials) or log the NAS in to `ghcr.io` with a personal access token that has `read:packages`.
