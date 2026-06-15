# Release Checklist

Use this checklist before making the repository public.

## 1. Repository Hygiene

- Confirm `node_modules/`, `dist/`, `coverage/`, logs, SQLite files, and temporary files are ignored.
- Confirm `~/.codex-wechat/` is never copied into the repository.
- Confirm these files are not present anywhere in the repo:
  - `.env`
  - `account.json`
  - `config.json` with real sender IDs or tokens
  - `state.sqlite`
  - `daemon.log`
  - QR images or screenshots containing account identifiers
- Run:

```bash
npm run scan:secrets
git status --short --ignored
```

## 2. Local Verification

```bash
npm run release:check
```

`release:check` runs:

- TypeScript typecheck
- Vitest tests
- production build
- Codex app-server schema generation
- local secret scan

## 3. Real Workflow Smoke Test

On a real macOS setup:

```bash
codex-beeper setup
codex-beeper bind-owner
codex-beeper configure
codex-beeper doctor
```

Then verify:

- `/projects` lists expected aliases only.
- `/new <alias> <prompt>` starts a Codex thread.
- A Codex Desktop/CLI completion triggers a WeChat notice.
- Quoting the notice resumes the correct thread.
- A command/file/apply_patch approval request is routed to WeChat.
- Deny, approve, and timeout paths behave correctly.
- `context_token` stale recovery retries undelivered notices after the owner sends any message.
- `codex-beeper watchdog run` reports useful actions/issues.

## 4. Security Posture

Recommended public default:

```json
{
  "wechatSecurity": {
    "ownerOnly": true,
    "allowLocalImageSend": true,
    "autoSendLocalImages": true,
    "allowedMediaRoots": []
  }
}
```

Before release, confirm `codex-beeper doctor` does not show high-risk action items for:

- `danger-full-access + never`
- `ownerOnly=false`
- local image sending configured with broad extra roots

## 5. GitHub Metadata

- Confirm the MIT license is acceptable before public release.
- Add repository topics: `codex`, `wechat`, `codex-app-server`, `developer-tools`, `local-first`, `chatops`.
- Add a short description:
  - `WeChat pager for Codex Desktop/CLI: completion notifications, quote-to-resume, remote approvals, and local watchdog.`
- Enable branch protection after first push.
- Confirm CI passes on GitHub Actions.

## 6. First Release Notes

Recommended first release title:

```text
v0.1.0 - Codex Beeper
```

Recommended release highlights:

- Codex Desktop/CLI completion notifications via Stop hook.
- WeChat `/new`, quote-to-resume, `/r`, `/show`, `/threads`.
- Remote approvals for command, file, patch, and permission requests.
- Local-first iLink long polling, no public webhook.
- launchd service and watchdog.
- Inbound message persistence and turn timeout recovery.
