# Security Plan — Mineflayer AI Swarm

**Specification:** 1.0.0  
**Security posture:** private authorised environment, least privilege, fail closed.

## 1. Threat model

Protect against:
- unauthorised dashboard users;
- stolen/replayed worker credentials;
- malicious or compromised worker hosts;
- spoofed/stale worker events;
- duplicate commands and resource-credit inflation;
- hostile chat input and prompt injection;
- malicious or malformed Ollama output;
- remote access to the Ollama API;
- Minecraft account credential exposure;
- denial of service through request, event, inference or SSE floods;
- data loss or inconsistent state after restart;
- accidental public-server use or excess server connections.

Assume a worker can fail, disconnect or report incorrect evidence. The coordinator must not trust a worker's self-reported completion counters.

## 2. Trust boundaries and principals

| Principal | Authentication | Permissions |
|---|---|---|
| Dashboard human | Server-managed session, password and optional MFA | Role-based tasks, monitoring and admin controls |
| Local CLI | Local operator credential or OS-protected secret | Explicit operator command set |
| Minecraft chat actor | Allowlisted server + player UUID | Narrow chat command allowlist |
| Worker host | Unique worker token, preferably TLS client identity where practical | Own bot heartbeats, leases, events and snapshots only |
| Bot account | Legitimate Minecraft authentication local to worker | Game actions permitted by server and configured policy |
| Ollama service | Private network + TLS/authenticated proxy boundary | Structured planning only; no direct control-plane write access |

Do not reuse credentials across principals. A worker token must not authenticate as a dashboard user. A Minecraft token must never be sent to the coordinator or Ollama.

## 3. Human dashboard and CLI authentication

- Use server-managed sessions with opaque high-entropy identifiers.
- Cookie: HttpOnly, Secure, SameSite=Lax or stricter where the deployment flow allows, Path=/, no Domain for __Host- prefixed cookies.
- Rotate session ID after login and privilege change.
- Enforce idle and absolute expiry.
- CSRF protection on state-changing browser requests; validate Origin and a session-bound CSRF token.
- Rate limit login by account and source, use generic failure responses and safe recovery.
- Passwords hashed using a current OWASP-recommended password hashing configuration (Argon2id is preferred where correctly supported).
- Do not store credentials or session IDs in localStorage/sessionStorage.
- Use secure bootstrap to provision first administrator. Never commit a default admin password.
- Roles: viewer, operator and admin. Every endpoint checks authorization server-side.
- CLI uses a separate local operator credential stored with restrictive filesystem permissions. On Android/Termux, document the limitations of filesystem permissions and prefer user-private app storage.
- Log authentication outcomes without passwords or tokens.

## 4. Worker identity and bootstrap

- Each WorkerHost has an immutable workerId and unique secret.
- Initial registration uses a one-time bootstrap credential provided out-of-band by an administrator.
- Bootstrap token is short-lived, single-use and scoped to registration.
- Coordinator generates a random high-entropy worker token after successful registration.
- Display/return raw worker token once; store only a secure verifier/hash at master.
- Worker stores its token in private local configuration with restrictive file permissions. Do not place it in source control, shared chat, command-line history or logs.
- Support token rotation and immediate revocation.
- Token revocation makes future heartbeat, poll and event requests fail and causes worker safe stop.
- Worker credentials are limited to that worker ID and its registered bot IDs.
- Require request replay protection with message IDs, worker sequence numbers, lease IDs and allocation epochs.
- Use TLS; private LAN/VPN is required. Prefer mutual TLS where deployment and Termux certificate handling permit it, but unique bearer credentials remain required even inside a VPN.

## 5. Worker protocol security

- Validate method, path, content type, schema version and body size.
- Authenticate before expensive parsing where possible.
- Apply rate and payload limits by worker identity.
- Reject unknown JSON properties and unsupported protocol versions.
- Require monotonically increasing worker sequence numbers; deduplicate messageId.
- Validate assignment ownership and allocationEpoch for every event.
- Use server-side receive time for lease deadlines.
- Workers may only acknowledge and report their own commands.
- Worker cannot request arbitrary task IDs, bot IDs or another worker's snapshot.
- Do not accept arbitrary URL, shell command, JavaScript or filesystem path from worker messages.
- Treat all reported inventory and action results as evidence requiring validation.

## 6. Minecraft authentication and server authorisation

- Offline-mode usernames are allowed only for a private test server under the project owner's control.
- Online-mode use requires legitimate separately authenticated Microsoft/Minecraft accounts using the supported authentication flow for the pinned Mineflayer version.
- Store authentication state only on the worker host that owns the bot.
- Never bypass Microsoft login, server authentication, anti-cheat, CAPTCHA, access controls, player limits or server moderation.
- Do not spoof identities or reuse another player's tokens.
- Configure an explicit allowed server list and environment profile. Production mode refuses unknown hosts.
- Require operator-confirmed per-server max connection count.
- Rate-limit login/reconnect attempts and respect kick/ban/server responses. Repeated kick or authentication failure pauses the bot and alerts the operator rather than retrying indefinitely.

## 7. Chat-command security

- Require server profile + player UUID allowlist.
- Bot-originated messages are ignored.
- Strict command prefix and parser; no eval, shell, JavaScript, command blocks or arbitrary plugin dispatch.
- Role-check actions: status may be read-only; task creation, pause and cancel require appropriate permission.
- Per-player rate limit and maximum message length.
- Natural-language task text remains untrusted and is passed as data to ReasoningEngine.
- High-risk or ambiguous plans require clarification/operator approval.
- Reply without leaking account IDs, tokens, filesystem paths or private settings.

## 8. Ollama security

- Ollama runs on a device controlled by the user, separate from the phone.
- It is reachable only over private LAN/VPN and never directly exposed to the public internet.
- Use TLS and authenticated reverse proxy or equivalent network protection; do not assume Ollama itself authenticates callers.
- Firewall ingress to the model host and restrict caller to the coordinator.
- Never send Minecraft, worker, dashboard or Microsoft credentials.
- Send allowlisted compact snapshots only.
- Validate model output against a strict JSON Schema and semantic policy.
- Disable tools/function execution for planning requests unless a future reviewed design explicitly requires a safe, separately permissioned tool layer.
- No paid fallback provider, cloud endpoint or hidden metered service.
- If Ollama is unavailable, follow deterministic fallback rules.

## 9. Task and action safety

- Only allowlisted action types can be dispatched.
- Each assignment has action deadline, lease expiry, risk level, resource quota and scope.
- Worker performs deterministic precondition checks before action.
- Unsafe/unloaded/unknown terrain is not treated as safe.
- Stop on death, disconnection, lease expiry, critical health/food, tool failure or server rejection according to policy.
- Do not continue a task after the assignment lease expires.
- Prevent two bots from mining/placing the same reserved coordinate or taking the same unique item without explicit coordination.
- Build and transfer operations require bounds and verification.
- A task cannot change its target quantity through worker messages.
- AI cannot grant permissions, disable safety checks or set server connection limits.

## 10. Persistence and secret handling

- Store password hashes, worker credential verifiers and session metadata, not raw credentials.
- Encrypt or otherwise protect sensitive local auth data at rest where the platform supports it.
- Restrict filesystem permissions on Termux data directories.
- Keep runtime secrets in a local secrets file or environment injection; exclude from Git.
- Provide .env.example with dummy values only.
- Redact secrets from structured logs, errors, diagnostics and support bundles.
- Parameterize SQL; never concatenate user values into statements.
- Use transactions for tasks, assignments, inventory ledger and idempotency records.
- Back up the database; verify restore, not merely backup creation.
- Do not include private task/player data in telemetry by default.

## 11. HTTP and browser security

- HTTPS only for non-loopback network interfaces.
- Bind only to the intended VPN/LAN interface, or bind broadly only with explicit firewall restrictions.
- Restrict CORS to exact configured dashboard origins; avoid wildcard credentialed CORS.
- Secure headers including CSP, frame restrictions, content-type sniffing protections and referrer policy.
- CSRF protection for cookie-authenticated mutations.
- Request body and upload limits; no arbitrary file upload in initial release.
- Session invalidation and role checks on every protected request.
- SSE authentication and bounded connections/queues.
- Do not leak detailed stack traces to clients.

## 12. Incident and recovery procedure

If a worker credential is suspected compromised:
1. Revoke its worker identity immediately.
2. Stop/revoke its active leases and fence its allocation epochs.
3. Review recent task evidence and resource ledger transactions.
4. Rotate any related secrets on the worker.
5. Re-register it with a fresh bootstrap credential.
6. Resume only after operator verification.

If Minecraft authentication state is exposed, revoke the relevant account session using the legitimate account provider procedure; do not copy that state to the master.

If Ollama is exposed publicly, close network ingress, rotate proxy credentials/certificates, review access logs and verify the endpoint is private before reconnecting.

