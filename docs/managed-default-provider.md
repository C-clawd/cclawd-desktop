# Default AI Provider

## Goal

Cclawd should be usable before the user configures a personal AI model provider in the UI. First-run setup should confirm that a usable model is available, not require the user to understand providers, models, base URLs, and API keys before reaching the app.

There are two designs:

- Long term: a Cclawd-managed provider resolved by a server-side adapter.
- Current MVP: a local default provider backed by a user-owned model account and written into OpenClaw config.

The MVP is intentionally simpler. The default provider key belongs to the user or deployment owner. If that key is leaked from the local machine, the user-owned upstream account bears that risk.

## Long-Term Security Boundary

The managed provider must not place upstream model credentials on the user's machine.

Do not store any of these in `~/.openclaw/openclaw.json`, Electron store, `.env`, bundled assets, or renderer code:

- upstream LLM API keys
- long-lived Cclawd provider keys
- managed provider base URLs that directly expose the upstream model vendor
- quota, tenant-routing, or billing-control rules

The desktop app may store only non-sensitive local state:

- the selected model reference, for example `cclawd-default/cclawd-auto`
- a system provider account marker used by the UI
- short-lived identity/session credentials if the app already has a login/token mechanism

The real upstream provider configuration belongs to the Cclawd server-side control plane.

## Long-Term Runtime Shape

`openclaw.json` should contain only the model choice:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cclawd-default/cclawd-auto",
        "fallbacks": []
      }
    }
  }
}
```

It should not contain:

```json
{
  "models": {
    "providers": {
      "cclawd-default": {
        "baseUrl": "...",
        "api": "...",
        "apiKey": "..."
      }
    }
  }
}
```

OpenClaw/Gateway must resolve `cclawd-default/*` through a managed provider adapter. That adapter calls Cclawd's server-side proxy, where real upstream model credentials, quota, limits, and audit policy live.

## MVP Runtime Shape

Until the managed adapter and runtime authentication are ready, `cclawd-default` is a local system account that maps to a user-owned upstream provider.

The desktop app reads local deployment settings from:

1. process environment variables, for temporary overrides
2. `~/.openclaw/.env`, for persistent local configuration

On startup, Cclawd also attempts a one-time backfill into `~/.openclaw/.env` when the default AI settings are missing. It first reads the current OpenClaw default model provider from `openclaw.json` and the matching user-owned API key from the main agent `auth-profiles.json`, then writes `CCLAWD_DEFAULT_AI_*`.

If no usable OpenClaw provider exists yet, Cclawd falls back to the bundled preset at `resources/config/default-ai-provider.json`. Existing `CCLAWD_DEFAULT_AI_PROVIDER` plus `CCLAWD_DEFAULT_AI_API_KEY` entries are treated as user-managed and are not overwritten.

On Windows, the persistent MVP configuration file is:

```text
C:\Users\<username>\.openclaw\.env
```

Example:

```text
CCLAWD_DEFAULT_AI_PROVIDER=moonshot
CCLAWD_DEFAULT_AI_MODEL=kimi-k2.5
CCLAWD_DEFAULT_AI_BASE_URL=https://api.moonshot.cn/v1
CCLAWD_DEFAULT_AI_API=openai-completions
CCLAWD_DEFAULT_AI_API_KEY=sk-...
CCLAWD_DEFAULT_AI_API_KEY_ENV=CCLAWD_DEFAULT_AI_API_KEY
CCLAWD_DEFAULT_AI_HEADERS={"HTTP-Referer":"https://claw-x.com","X-Title":"Cclawd"}
```

The minimum Moonshot-style configuration is:

```text
CCLAWD_DEFAULT_AI_PROVIDER=moonshot
CCLAWD_DEFAULT_AI_API_KEY=sk-...
```

Required:

- `CCLAWD_DEFAULT_AI_PROVIDER`
- `CCLAWD_DEFAULT_AI_API_KEY`

Optional values fall back to the provider registry when possible:

- `CCLAWD_DEFAULT_AI_MODEL`
- `CCLAWD_DEFAULT_AI_BASE_URL`
- `CCLAWD_DEFAULT_AI_API`
- `CCLAWD_DEFAULT_AI_API_KEY_ENV`
- `CCLAWD_DEFAULT_AI_HEADERS`

The bundled preset file has the same shape:

```json
{
  "enabled": true,
  "provider": "custom",
  "model": "glm-5",
  "baseUrl": "https://api.lkeap.cloud.tencent.com/coding/v3",
  "api": "openai-completions",
  "apiKey": "sk-...",
  "apiKeyEnv": "CCLAWD_DEFAULT_AI_API_KEY"
}
```

`apiKey` must be a real usable default-provider key. Placeholder values such as `REPLACE_WITH_DEFAULT_PROVIDER_API_KEY` are ignored, so packaged builds must replace the placeholder before release if they are expected to work without user configuration.

When configured, Cclawd writes a real OpenClaw provider entry:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cclawd-default/kimi-k2.5",
        "fallbacks": []
      }
    }
  },
  "models": {
    "providers": {
      "cclawd-default": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "api": "openai-completions",
        "apiKey": "CCLAWD_DEFAULT_AI_API_KEY",
        "models": [{ "id": "kimi-k2.5", "name": "kimi-k2.5" }]
      }
    }
  }
}
```

The key value is also synced to OpenClaw `auth-profiles.json` under provider `cclawd-default`, so Gateway can resolve the configured `apiKey` reference.

If the local default provider settings are missing from both the process environment and `~/.openclaw/.env`, the system account may be displayed as unconfigured, but setup must not treat it as a usable model.

## Module Design

The desktop app should expose one small Main-process interface:

```ts
ensureUsableDefaultProvider(options?: {
  gatewayManager?: GatewayManager;
  reason?: string;
}): Promise<ManagedDefaultProviderStatus>
```

The implementation owns the details:

- detect whether a user-owned provider is configured
- create or refresh a readonly system account for Settings/Setup display
- long term: set the default model to `cclawd-default/cclawd-auto` only when no user provider is usable
- MVP: set the default model to `cclawd-default/<configured-model>` and write the local provider entry
- read MVP local provider settings from process env first and `~/.openclaw/.env` second
- backfill `~/.openclaw/.env` from the current OpenClaw provider/auth profile during app startup when default AI entries are absent
- fall back to `resources/config/default-ai-provider.json` when there is no existing OpenClaw provider to backfill from
- avoid writing Cclawd-managed secrets; MVP local provider credentials are user-owned
- trigger Gateway reload only when the model reference changes

Callers should only need to ask whether a usable provider exists.

## Setup Behavior

The setup provider step changes from "configure an AI provider" to "confirm a usable model".

Proceed when:

- a user provider with usable credentials exists, or
- the managed default provider is ready

The provider setup UI remains useful as an optional bring-your-own-key path. Users who need private billing, enterprise routing, local Ollama, or custom base URLs can still configure their own provider in Setup or Settings.

## Settings Behavior

Settings > AI Providers may show the managed provider as a readonly system account:

- label: `Cclawd Default`
- auth mode: `managed`
- default: yes when selected
- no API-key field
- no delete/edit key behavior

User-owned providers always take precedence. If a user configures and selects their own provider, the managed provider should not overwrite the default model.

## Implementation Notes

- `cclawd-default` is a provider type in the shared provider registry, but it is not a keyable provider and has no `envVar`.
- `ProviderAuthMode` includes `managed`.
- `ProviderAccount.metadata.origin = "system"` marks the account as managed.
- `openclaw.json` active-provider discovery must treat `agents.defaults.model.primary` as sufficient to display the system provider account.
- Runtime sync functions must not call `syncProviderConfigToOpenClaw` or `saveProviderKeyToOpenClaw` for `managed` accounts.

## Future Runtime Work

The MVP can call models through the local default provider configuration because it writes a real `models.providers.cclawd-default` entry and syncs the user-owned key to OpenClaw auth profiles.

The long-term managed-provider design still needs an OpenClaw/Gateway adapter for `cclawd-default/*`. That adapter should use the runtime authentication design in `docs/cclawd-runtime-auth.md` and move upstream keys back to Cclawd-controlled infrastructure.
