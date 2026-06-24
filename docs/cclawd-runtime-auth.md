# Cclawd Runtime Authentication

## Goal

Cclawd Desktop needs to call Cclawd-hosted capabilities such as Guard audit APIs and the future managed default LLM provider. Those services must be able to tell whether a request comes from a registered Cclawd client session instead of an arbitrary forged HTTP client.

This document describes the long-term authentication design. It is not required for the current local-default-provider MVP.

## Placement

`cclawd-guard-core` is currently the backend for `cclawd-desktop`, so the first implementation should live inside that Java service instead of starting a separate auth service.

Suggested package layout:

```text
com.cclawd.guard.auth.runtime
  RuntimeAuthFilter.java
  RuntimeAuthService.java
  RuntimeTokenService.java
  DeviceRegistry.java
  NonceReplayProtector.java
  RequestCanonicalizer.java
  SignatureVerifier.java
  RuntimePrincipal.java
  RuntimeAuthProperties.java
```

Keep the protocol names generic (`Cclawd Runtime Auth`) so this module can later be extracted into a shared package or standalone service.

## Trust Model

Do not put a fixed client secret in the Electron app. It can be extracted.

Authenticate a device and session instead:

- Desktop Main process creates a device key pair.
- The private key stays in OS secure storage.
- Guard Core stores the public key and device status.
- Desktop obtains short-lived runtime tokens.
- Each protected request carries both the token and a proof-of-possession signature.

## Device Registry

The service needs to remember registered devices and their public keys:

```sql
cclawd_runtime_device
  id
  user_id
  tenant_id
  device_public_key
  key_algorithm
  device_name
  app_version
  status
  created_at
  last_seen_at
  revoked_at
```

This table does not store private keys, upstream LLM keys, or model provider secrets. It stores only the public key and device state needed for verification, revocation, audit attribution, and future quota policy.

## Token Shape

Use short-lived JWTs. Separate capabilities by audience and scope.

Guard audit:

```json
{
  "sub": "user_xxx",
  "device_id": "device_xxx",
  "aud": "cclawd-guard-core",
  "scope": ["guard:audit:read"],
  "exp": 1234567890
}
```

Future managed LLM:

```json
{
  "sub": "user_xxx",
  "device_id": "device_xxx",
  "aud": "cclawd-managed-llm",
  "scope": ["llm:chat"],
  "exp": 1234567890
}
```

An audit token must not be accepted by the managed LLM endpoint, and an LLM token must not be accepted by audit endpoints.

## Signed Request Headers

Protected requests should include:

```http
Authorization: Bearer <short-lived-token>
X-Cclawd-Device-Id: <device-id>
X-Cclawd-Timestamp: <unix-ms>
X-Cclawd-Nonce: <random>
X-Cclawd-Body-SHA256: <hex-body-hash>
X-Cclawd-Signature: <base64-signature>
```

Canonical string:

```text
METHOD\n
PATH_WITH_QUERY\n
TIMESTAMP\n
NONCE\n
BODY_SHA256
```

The server validates:

- JWT signature, expiration, audience, and scope
- device exists and is active
- token device matches `X-Cclawd-Device-Id`
- timestamp is inside the allowed window, for example 5 minutes
- nonce has not been used before
- body hash matches the received body
- request signature verifies with the registered public key

Store used nonces in Redis:

```text
runtime-auth:nonce:{deviceId}:{nonce} -> 1, TTL 10 minutes
```

## Desktop Flow

Renderer must not call Guard Core directly. Use Main as the only caller that can access private keys and runtime tokens:

```text
Renderer
  -> host-api/api-client
  -> Electron Main signed fetch
  -> cclawd-guard-core
```

The Renderer receives business data only.

## First Protected Surface

Protect Guard audit endpoints first:

```text
/api/audit/**
```

Leave health checks, registration, and ops login outside this filter unless they get a separate authentication policy.

## Local Development

Allow an explicit local switch:

```yaml
cclawd:
  runtime-auth:
    enabled: false
```

Production should default to enabled.
