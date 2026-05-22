<p align="center">
  <img src="docs/assets/logo.png" alt="SMTP Load Balancer logo" width="200"
  style = "border-radius: 30%;"/>
</p>

<h1 align="center">SMTP Load Balancer</h1>

<p align="center">
  <strong>Easily distribute emails across multiple upstream SMTP providers</strong>
</p>

<p align="center">
  <a href="#about">About</a> •
  <a href="#prerequisites">Prerequisites</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#usage">Usage</a> •
  <a href="#dashboard">Dashboard</a> •
  <a href="#security">Security</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="https://discord.gg/7qK8sfEq2q">
    <img src="https://img.shields.io/discord/1068543728274382868?color=7289da&label=Support&logo=discord&logoColor=7289da&style=for-the-badge" alt="Discord">
  </a>
  <a href="https://www.python.org/">
    <img src="https://img.shields.io/github/languages/top/ovosimpatico/smtp-loadbalancer?logo=javascript&logoColor=yellow&style=for-the-badge" alt="Language">
  </a>
  <a href="https://github.com/ovosimpatico/smtp-loadbalancer/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ovosimpatico/smtp-loadbalancer?style=for-the-badge" alt="License">
  </a>
</p>

## About

**SMTP Load Balancer** is a powerful tool designed to distribute emails across multiple upstream SMTP providers, ensuring high availability, reliability and scalability.

Key features:

* **Durable queue** — accepted mail is persisted to disk immediately and retried on failure; nothing is lost on restart.
* **Dead-letter queue** — emails that can't be delivered after all retries are written to `data/dead-letter/` instead of being dropped.
* **Quota-aware routing** — in SMTP2GO mode, traffic is balanced by remaining daily/monthly quota, with rate-limit and error cooldown protection.
* **Connection pooling** — upstream SMTP connections are reused for higher throughput.
* **Web dashboard** — live per-provider statistics, including bounce and spam metrics in SMTP2GO mode.
* **Prometheus metrics** — exposed at `/metrics`.

## Prerequisites

To use SMTP Load Balancer, you'll need:
*   One or more SMTP email providers

For deployment:
*   **Docker & Docker Compose** (Recommended)
*   OR **Node.js 24+**

## Installation

### Using Docker (Recommended)

1.  Create a directory for your configuration:
    ```bash
    mkdir smtp-loadbalancer && cd smtp-loadbalancer
    ```
2.  Download the example configuration and docker-compose file:
    ```bash
    curl -O https://raw.githubusercontent.com/ovosimpatico/smtp-loadbalancer/main/config.example.json
    curl -O https://raw.githubusercontent.com/ovosimpatico/smtp-loadbalancer/main/docker-compose.yml
    ```
3.  Create your `config.json` file:
    ```bash
    cp config.example.json config.json
    nano config.json
    ```
4.  Run the application:
    ```bash
    docker compose up -d
    ```
5.  The SMTP server will be listening on port `2525`.

### Native Node.js Installation

1.  Clone the repository and enter the directory:
    ```bash
    git clone https://github.com/ovosimpatico/smtp-loadbalancer.git
    cd smtp-loadbalancer
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Make your `config.json` file based on the [example file](config.example.json)
    ```bash
    cp config.example.json config.json
    nano config.json
    ```
4.  Run the server:
    ```bash
    npm start
    ```
5.  The SMTP server will be listening on port `2525`.

## Configuration

Configuration lives in `config.json`. See [config.example.json](config.example.json) for a complete example. Most fields are optional and have sensible defaults.

### `server` — the inbound SMTP listener

| Field | Default | Description |
|-------|---------|-------------|
| `host` | `0.0.0.0` | Address to bind the SMTP listener to. |
| `port` | — | SMTP port (required). |
| `auth` | — | `{ user, pass }`. **Strongly recommended** — without it the server relays mail from anyone. |
| `tls` | — | `{ key, cert, ca }` PEM file paths. Enables STARTTLS so credentials are not sent in cleartext. |
| `allowInsecureAuth` | `true` | Allow AUTH before STARTTLS. Set `false` once TLS is configured. |
| `maxMessageSize` | `26214400` | Maximum message size in bytes (25 MB). |
| `maxRecipients` | `100` | Maximum recipients per message. |
| `allowedRecipientDomains` | `[]` | If non-empty, only these recipient domains are accepted. |
| `useXClient` / `useXForward` | `false` | Enable only behind a trusted proxy (see `trustedProxies`). |
| `trustedProxies` | `[]` | When `useXClient`/`useXForward` is on, only these IPs may connect. |

### `api` — the dashboard / metrics server

| Field | Default | Description |
|-------|---------|-------------|
| `host` | `0.0.0.0` | Address to bind the HTTP server to. |
| `port` | `8080` | HTTP port. |
| `auth` | — | `{ user, pass }` HTTP Basic auth for the dashboard, `/stats` and `/metrics`. `/health` stays public. |

### `queue` — delivery queue

| Field | Default | Description |
|-------|---------|-------------|
| `maxRetries` | — | Number of delivery attempts before dead-lettering. |
| `retryDelay` | — | Delay between retries, in ms. |
| `concurrent` | `5` | Number of emails delivered in parallel. |
| `afterProcessDelay` | `1` | Delay between processing tasks, in ms. |

### `providers` — upstream SMTP accounts

Each provider needs `name`, `host`, `port`, `secure`, `auth` and `from`. Optional: `pool` (default `true`), `maxConnections`, `maxMessages`, and — for SMTP2GO mode — `api_key`, `daily_limit`, `monthly_limit`.

### `smtp2go` — quota-aware routing tuning (SMTP2GO mode only)

| Field | Default | Description |
|-------|---------|-------------|
| `pollIntervalMs` | `300000` | How often to refresh stats from the SMTP2GO API. |
| `dailyReserveRatio` | `0.02` | Safety margin kept below each daily limit to avoid overshoot. |
| `errorCooldownMs` | `300000` | How long a provider is skipped after a rate-limit / error. |
| `rateLimit.maxPerMinute` | `0` | Per-provider short-term send cap (`0` = unlimited). |
| `timezone` | `UTC` | Timezone used to decide when daily counters reset. |

### `logging`

| Field | Default | Description |
|-------|---------|-------------|
| `redactPII` | `false` | Mask email addresses in log output. |

## Usage

The software will be listening on port `2525` and will be accepting emails.

To send emails, you can use:

SMTP-compatible email clients:
- [Thunderbird](https://www.thunderbird.net/)
- [Microsoft Outlook](https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook)
- [Evolution](https://gitlab.gnome.org/GNOME/evolution/-/wikis/home)
- [K-9 Mail](https://k9mail.app/)
- [`mail` CLI](https://man.archlinux.org/man/mail.1.en)

SMTP libraries for programming languages:
- [Node.js (nodemailer)](https://www.npmjs.com/package/nodemailer)
- [Python (smtplib)](https://docs.python.org/3/library/smtplib.html)
- [PHP (PHPMailer)](https://github.com/PHPMailer/PHPMailer)
- [C# (MailKit)](https://github.com/jstedfast/MailKit)
- [Go (net/smtp)](https://pkg.go.dev/net/smtp)

Or, you may integrate it with your self-hosted services, like Nextcloud or Forgejo.

Once integrated, you can use the SMTP Load Balancer as your primary email server.

**Note:** Since the FROM address will already be set for each provider, the FROM field on your sent emails will be rewritten to the provider address, and the original sender is preserved as the REPLY-TO address so replies reach the correct person.

## Dashboard

A web dashboard is served on port `8080` (configurable via `api`). It shows live per-provider statistics, queue depth, delivery/retry/dead-letter counts, and — in SMTP2GO mode — daily/monthly quota usage plus bounce and spam metrics.

Additional endpoints:
- `GET /health` — health check (public, used by the container healthcheck).
- `GET /stats` — JSON statistics (powers the dashboard).
- `GET /metrics` — Prometheus-format metrics.
- `GET /dead-letters` — list of recent dead-letter records.

## Provider-specific modes

### Generic mode

This mode generates local metrics and allows you to use any SMTP provider, as well as mix and match providers. Delivery is distributed round-robin.

### SMTP2GO mode

This mode uses the SMTP2GO API to fetch usage metrics and applies **quota-aware load balancing**: each email is routed to the account with the most effective remaining quota (the smaller of its daily and monthly headroom). Accounts that hit a limit, get rate-limited, or return errors are temporarily skipped, so traffic is spread evenly and you avoid being throttled for overuse. Daily counters are persisted to disk and survive restarts.

For this mode to work, you need to provide an API key for each account. All API keys must have the following permissions (set in the SMTP2GO dashboard):
- Statistics
- Activity

## Security

* **Always set `server.auth`** — without it the load balancer is an open relay.
* **Configure `server.tls`** so SMTP credentials and message content are not transmitted in cleartext.
* **Set `api.auth`** to protect the dashboard, and prefer binding the API to `127.0.0.1` (the provided `docker-compose.yml` does this).
* Keep `config.json` private — it contains provider credentials. It is excluded from version control by default.

## Development

Run the test suite with:

```bash
npm test
```

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**. This means that you are free to use, modify and distribute the software, so as long as you release the source code of your fork to all users, even when interacting with it over a network.

See the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with any email service provider, and it's not a replacement for a dedicated email server, but rather a relay server for outgoing email services.

This project is not intended to be used to circumvent or abuse any email service provider's policies or to send spam.

This tool is provided "as is", without any warranty. Use at your own risk. By using it, you agree and respect the terms of the [AGPLv3 License](LICENSE) and all terms of service of the email service providers you use.
