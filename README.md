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
  <a href="#usage">Usage</a> •
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

## Prerequisites

To use SMTP Load Balancer, you'll need:
*   One or more SMTP email providers

For deployment:
*   **Docker & Docker Compose** (Recommended)
*   OR **Node.js 24+**

## Installation

TODO: Docker support
### Using Docker (Recommended) TODO

1.  Clone the repository:
    ```bash
    git clone https://github.com/ovosimpatico/smtp-loadbalancer.git
    cd smtp-loadbalancer
    ```
2.  Make your `config.json` file based on the [example file](config.example.json)
    ```bash
    cp config.example.json config.json
    nano config.json
    ```
3.  Run the application:
    ```bash
    docker compose up -d
    ```
4.  The SMTP server will be listening on port `2525`.

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

**Note:** Since the FROM address will already be set for each provider, the FROM field on your sent emails will be rewritten to the REPLY-TO address, to ensure replies are sent to the correct address.

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPLv3)**. This means that you are free to use, modify and distribute the software, so as long as you release the source code of your fork to all users, even when interacting with it over a network.

See the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with any email service provider, and it's not a replacement for a dedicated email server, but rather a relay server for outgoing email services.

This project is not intended to be used to circumvent or abuse any email service provider's policies or to send spam.

This tool is provided "as is", without any warranty. Use at your own risk. By using it, you agree and respect the terms of the [AGPLv3 License](LICENSE) and all terms of service of the email service providers you use.