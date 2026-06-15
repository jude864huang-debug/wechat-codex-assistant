# Security Policy

Codex Beeper runs local Codex turns from a chat app. Treat it as a remote-control surface for your machine.

## Supported Versions

This project is pre-1.0. Security fixes target the latest `main` branch until tagged releases exist.

## Safe Defaults

- Remote control is owner-only by default.
- Local image sending is enabled by default, but only for images inside the current project directory unless extra roots are explicitly configured.
- WeChat can only select configured project aliases, not arbitrary local paths.
- `notifyOnly` projects can receive notifications but cannot be resumed from WeChat.
- Approval requests time out and deny by default.

## Sensitive Files

Do not commit:

- `~/.codex-wechat/account.json`
- `~/.codex-wechat/config.json`
- `~/.codex-wechat/*.sqlite`
- `~/.codex-wechat/*.log`
- `.env`
- API keys, bot tokens, OAuth credentials, QR screenshots, or real account IDs.

## Reporting Issues

For public repositories, open a GitHub Security Advisory or contact the maintainer privately if the issue includes credentials, account identifiers, or a practical exploit path.

For normal bugs without sensitive material, open a GitHub issue.
