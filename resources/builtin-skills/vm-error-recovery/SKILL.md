---
name: vm-error-recovery
version: 1.0.0
description: "Diagnose and guide recovery for Cclawd Desktop runtime issues, including startup, Gateway, Host API, Cloud guard connectivity, audit data, skills, extensions, channel bindings, configuration drift, network, proxy, and certificate problems."
description_zh: "诊断并引导用户修复 Cclawd Desktop 运行环境问题，包括桌面端启动、Gateway、Host API、Cloud/cclawd-guard、审计数据、技能、插件、消息渠道、配置漂移、网络、代理和证书问题。"
---

# Cclawd Desktop Runtime Recovery

Use this skill when the user reports Cclawd Desktop runtime problems and needs safe, step-by-step recovery help.

## When To Use

- Cclawd Desktop cannot start, shows a blank screen, or freezes.
- OpenClaw Gateway fails to start, disconnects, or reports unhealthy state.
- Host API on `http://127.0.0.1:3210` is unreachable.
- Gateway port `18789` is unavailable, occupied, or unstable.
- The audit page has no data, cannot request data, or shows authorization or network errors.
- `cclawd-guard` cannot connect to Cloud, test, or production backend.
- `~/.openclaw/openclaw.json` changes unexpectedly, especially `coreUrl`.
- Skills are missing, corrupted, cannot be enabled, or fail to load from marketplace.
- Extensions or message channels fail to bind, receive, or send messages.
- Windows path, permission, proxy, certificate, firewall, or corporate network issues affect Cclawd Desktop.

## Safety Rules

- Do not delete `~/.openclaw` or reset all user data unless the user explicitly confirms.
- Back up configuration files before editing them.
- Keep test and production URLs clearly separated. Ask the user to confirm before switching environments.
- Do not overwrite user-managed skills, extensions, credentials, or channel bindings unless the fix specifically requires it.
- Prefer the smallest reversible fix first, then verify.
- Explain recovery steps in the user's language and avoid unnecessary internal details.

## Diagnostic Workflow

1. Clarify the symptom and recent changes.
   - Ask what page or action failed.
   - Ask whether the issue started after changing environment, upgrading, editing `openclaw.json`, deleting credentials, or installing skills/extensions.

2. Check application logs.
   - Look for Electron, main process, renderer, Gateway, skill, extension, and guard request errors.
   - On Windows, common log locations include `%APPDATA%\cclawd\logs` and Cclawd Desktop's application data directory.

3. Check Host API.
   - Verify whether `http://127.0.0.1:3210` responds.
   - If it does not respond, check whether Desktop is running, whether the main process started cleanly, and whether a local firewall or security product blocked the port.

4. Check OpenClaw Gateway.
   - Verify Gateway health and port `18789`.
   - Check whether another process is occupying the port.
   - Restart only the affected process if possible.

5. Check configuration.
   - Inspect `C:\Users\<user>\.openclaw\openclaw.json`.
   - Confirm `plugins.entries.cclawd-guard.enabled` is `true`.
   - Confirm `plugins.entries.cclawd-guard.config.coreUrl` points to the intended environment.
   - Confirm Desktop build-time defaults or environment variables are not rewriting user configuration unexpectedly.

6. Check Cloud and `cclawd-guard`.
   - Confirm the backend URL is reachable in a browser or with a simple HTTP request.
   - Confirm Cloud mode is expected for the current branch or deployment.
   - For the test environment, verify `coreUrl` points to the test `cclawd-guard-core` base path.
   - For audit issues, verify the frontend, Desktop config, Gateway, and guard-core all use the same environment.

7. Check skills.
   - Inspect `C:\Users\<user>\.openclaw\skills`.
   - Inspect built-in skill markers such as `.Cclawd-builtin.json`.
   - If a built-in skill is missing or corrupted, reinstall only that skill from the bundled built-in resources.
   - Check marketplace search or install failures separately from local built-in skill loading.

8. Check extensions and channels.
   - Inspect `C:\Users\<user>\.openclaw\extensions`.
   - Confirm only one account is bound per channel when Desktop is using the single main agent mode.
   - For channel binding problems, check whether the binding was created for `main agent` and whether stale bindings remain.

9. Apply a minimal fix and verify.
   - Restart Cclawd Desktop.
   - Re-open the failed page.
   - Confirm the relevant config remains stable after restart.
   - Confirm logs no longer show the original error.

## Playbooks

### Audit Page Has No Data

1. Confirm whether the audit page request is sent from Desktop.
2. Check `openclaw.json` and verify `cclawd-guard.config.coreUrl` points to the intended test or production environment.
3. Check whether Desktop is using Cloud mode and whether guard-core accepts Cloud authentication.
4. Verify the backend has audit records for the current user or tenant.
5. Compare browser devtools errors with Desktop main-process logs.
6. If the request goes to the wrong environment, fix the source that rewrites `coreUrl`, then restart Desktop and confirm the file remains unchanged.

### `coreUrl` Reverts After Restart

1. Record the value before restart.
2. Start Desktop and immediately re-check `openclaw.json`.
3. Search Desktop code and environment files for default guard URL values.
4. Check whether first-run plugin initialization, migration logic, or environment variables rewrite `plugins.entries.cclawd-guard.config.coreUrl`.
5. Fix the rewriting source instead of manually editing the file repeatedly.

### Gateway Port Is Occupied

Use PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue
Get-Process -Id (Get-NetTCPConnection -LocalPort 18789).OwningProcess
```

If the owner is an old Cclawd/OpenClaw process, close Cclawd Desktop and stop only that process. Do not kill unrelated processes without checking with the user.

### Host API Is Unreachable

1. Confirm Desktop is running.
2. Check whether port `3210` is listening.
3. Check main-process logs for startup failures.
4. Check whether security software blocked local loopback traffic.
5. Restart Desktop and verify the API again.

### Built-In Skill Missing Or Corrupted

1. Locate the bundled skill under Cclawd Desktop resources.
2. Locate the installed skill under `C:\Users\<user>\.openclaw\skills`.
3. Back up the installed skill directory.
4. Replace only the corrupted built-in skill.
5. Keep user-created skills untouched.

### Qoder Marketplace Search Or Install Fails

1. Confirm the marketplace URL is the China site when required: `https://qoder.com.cn/marketplace`.
2. Check network, proxy, and certificate errors.
3. Verify Desktop's marketplace API route returns normalized skills.
4. If a skill cannot install, check the package URL, archive format, and local write permission.

### Channel Binding Is Stuck

1. Confirm Desktop is in single main agent mode.
2. Confirm the channel binds directly to `main agent`.
3. Check whether a stale binding exists for the same channel.
4. Rebind only the affected channel after backing up the channel config.
5. Verify the channel can receive and send messages.

## Useful Commands

Check common ports:

```powershell
Get-NetTCPConnection -LocalPort 3210 -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue
```

Back up OpenClaw config:

```powershell
Copy-Item "$env:USERPROFILE\.openclaw\openclaw.json" "$env:USERPROFILE\.openclaw\openclaw.json.bak"
```

Read guard configuration:

```powershell
Get-Content "$env:USERPROFILE\.openclaw\openclaw.json" -Raw
```

Search for guard URL defaults in the Desktop project:

```powershell
rg "CCLAWD_GUARD_BASE_URL|coreUrl|cclawd-guard-core" C:\Users\<user>\ai-project\cclawd\cclawd-desktop
```

## Verification Checklist

- Cclawd Desktop opens without blank screen or startup error.
- Host API on `127.0.0.1:3210` responds.
- Gateway on port `18789` starts and stays healthy.
- `openclaw.json` keeps the intended `coreUrl` after restart.
- Audit page requests the intended environment and returns expected data.
- Skills page shows built-in, installed, and marketplace skills correctly.
- Message channel binding uses `main agent` and does not allow duplicate account binding for the same channel.
