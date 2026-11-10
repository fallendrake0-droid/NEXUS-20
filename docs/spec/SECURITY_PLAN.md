# Security, Trust Boundaries & Operational Safety Plan

**Document:** `docs/spec/SECURITY_PLAN.md`  
**Specification version:** 1.1.0  
**Posture:** Secure-by-default, fail-closed, least-privilege, explicitly authorised servers & workers only.

---

## 1. Threat Model & Trust Boundaries

| Principal / Component | Trust Level | Security Controls |
|---|---|---|
| Human Operator (`viewer` / `operator` / `admin`) | Authenticated human | Password hash (`scrypt`/`argon2id`), opaque server-side session, CSRF token + `Origin` check, RBAC, audit trail |
| Local Termux CLI (`cli_operator`) | Authenticated local process | Dedicated `SWARM_CLI_TOKEN` (`0600` perms in `$HOME`) over loopback or TLS |
| Remote `WorkerHost` (`worker`) | Semi-trusted execution node | One-time TTL `bootstrapToken` -> scoped `workerToken` (SHA-256 verifier only stored), bound to `workerId` + `allowedBotIds`, fenced by `allocationEpoch` |
| Remote Ollama Server | Untrusted advisory model | Outbound-only to allowlisted LAN/VPN host; `PlanningContextV1 <= 8 KiB`; zero secrets/chunks; strict `SchemaValidator`; zero direct bot control |
| Minecraft Server & In-Game Chat | Untrusted external input | `ChatHistoryGuard` drops unprefixed/bot/unlisted chat in `O(1)`; allowlisted commands pass through `Coordinator` RBAC (`chat_allowed` subset); zero shell/eval |
| Local Filesystem (`$HOME`) | Restricted storage | `0700` data dir, `0600` SQLite WAL + config files, zero secrets in git/logs/SSE/AI |

---

## 2. Authentication, KDF & Session Security (`AuthService`)

### 2.1 Password Hashing (Termux-Safe & Memory-Bounded)
- **Primary portable KDF (zero native C++ addon build on Android Bionic):** `node:crypto.scrypt` with `N = 32768`, `r = 8`, `p = 1`, `keylen = 32`, `salt = 16 random bytes`, `maxmem = 36 * 1024 * 1024` (`32 MiB` active block; measured `73.5 ms` per verification), serialized through a **concurrency-1 mutex** (max `4` waiting login requests; `429 RATE_LIMITED` beyond `4`) so login traffic can never spike phone RAM!
- **Optional Argon2id profile:** `m = 19456 KiB`, `t = 2`, `p = 1` when verified prebuilt/compiled on host (`U-03`). PHC-formatted password hashes (`$scrypt$...` or `$argon2id$...`) self-identify their algorithm.

### 2.2 Browser Sessions & CSRF Protection
- Cookie name: `__Host-swarm_session` (`HttpOnly; Secure; SameSite=Strict; Path=/`) over HTTPS (falls back to `swarm_session` with `HttpOnly; SameSite=Strict; Path=/` **only** when bound strictly to `127.0.0.1` local development).
- Session token: `32` bytes `crypto.randomBytes(32)` base64url; SQLite `sessions.session_id_hash` stores **only** `SHA-256(rawSessionToken)`.
- Idle timeout: `30 minutes`; absolute lifetime: `12 hours`; session rotated on login and privilege change.
- **CSRF defence on all state-changing `/api/v1/*` (`POST`/`PUT`/`PATCH`/`DELETE`):**
  1. Require `X-CSRF-Token` header matching session's `csrf_token_hash` via `crypto.timingSafeEqual`.
  2. Require `Origin` (or `Referer` if `Origin` absent) to match configured Dashboard origin (`403 CSRF_INVALID` on mismatch).
  3. Require `Content-Type: application/json`.

### 2.3 Login & Auth Rate Limiting
- Per `(ip, username)` sliding window in bounded `BoundedCache`: max `5` failed logins per `15 minutes` -> `429 RATE_LIMITED` + audit event `auth.login_rate_limited`.

---

## 3. Endpoint RBAC Matrix

| Endpoint / Action | `viewer` | `chat_allowed` | `operator` / `cli` | `admin` | `worker` |
|---|:---:|:---:|:---:|:---:|:---:|
| `GET /api/v1/health`, `/status`, `/workers`, `/bots`, `/tasks`, `/stream` | Allow | Deny | Allow | Allow | Deny |
| `POST /api/v1/tasks` (low/medium risk allowlisted intents) | Deny | Allow (via chat adapter) | Allow | Allow | Deny |
| `POST /api/v1/tasks/:id/{clarify,pause,resume,cancel}` | Deny | Own/safe subset | Allow | Allow | Deny |
| `POST /api/v1/bots/:botId/safe-stop` | Deny | Deny | Allow | Allow | Deny |
| `POST /api/v1/workers/bootstrap-tokens` | Deny | Deny | Deny | Allow | Deny |
| `POST /api/v1/workers/:workerId/revoke` | Deny | Deny | Deny | Allow | Deny |
| `POST /api/v1/admin/backup` | Deny | Deny | Deny | Allow | Deny |
| `POST /worker/v1/{heartbeat,ack,events,snapshots}`, `GET /worker/v1/commands` | Deny | Deny | Deny | Deny | Own `workerId` only |

**Worker ownership check:** On every `/worker/v1/*` request, `WorkerGateway` verifies `authWorker.workerId === payload.workerId` and every `botId` in the batch belongs to `authWorker.allowedBotIds`. Any cross-worker or cross-bot claim fails closed with `403 FORBIDDEN` and emits `security.worker_impersonation_blocked`.

---

## 4. Worker Enrollment, Transport & Revocation Lifecycle

1. **Transport:** All non-loopback traffic (`WorkerHost <-> Master`, remote browser `<-> Master`, non-private-VPN `Master <-> Ollama`) MUST use **HTTPS / TLS 1.3** (private CA / mTLS or encrypted WireGuard/Tailscale overlay verified by config). Plaintext HTTP on `0.0.0.0` or LAN IP without TLS is rejected at startup by `loadConfig`.
2. **Enrollment (`POST /worker/v1/register`):**
   - Admin generates a single-use `bootstrapToken` (`32` random bytes, TTL `<= 10 minutes`, only `SHA-256` stored in `worker_bootstrap_tokens`).
   - Worker presents `bootstrapToken` once and receives a unique `workerToken` (`32` random bytes, only `SHA-256` stored in `workers.token_verifier_hash`).
   - Replaying a consumed or expired `bootstrapToken` returns `401 UNAUTHENTICATED` and logs `security.bootstrap_token_replay`.
3. **Immediate Revocation (`POST /api/v1/workers/:workerId/revoke`):**
   - Sets `workers.revoked_at`, increments `allocation_epoch` on all active objectives held by `workerId`, transitions its active assignments to `cancelled`, and causes all subsequent `/worker/v1/*` calls from that token to fail with `401`.

---

## 5. Minecraft Account & Gameplay Ethics Controls

1. **Credential isolation:** Minecraft session/Microsoft OAuth caches stay strictly on the `WorkerHost` running that `BotController` (`0600` local directory) and are **never** transmitted to Master, Dashboard, SSE, logs or Ollama.
2. **Explicit server authorisation:** `WorkerHost` connects **only** to `(host, port, version)` entries listed in operator-signed config with `serverApprovedByOperator: true`.
3. **Anti-abuse & fair-play guardrails:**
   - Hard global cap `<= 20` bots; default `enabledBots = 2`.
   - Reconnect backoff (`2s -> 5s -> 15s -> 60s` + jitter); **immediate permanent stop** (`retryable: false`) on kick/ban/whitelist/auth messages so bots never hammer a server that rejected them.
   - `safetyPolicy.allowPvp` is schema-locked to `false`; griefing, exploit packets, chat spam and unauthorised chunk loading are prohibited.

---

## 6. Prompt-Injection & Untrusted Chat Containment

1. In-game chat from non-allowlisted senders or without the command prefix (`!swarm`) is dropped at `O(1)` by `ChatHistoryGuard` and **never** reaches Master or Ollama.
2. Even for allowlisted players, `ChatCommandAdapter` strips control characters, bounds length to `<= 240` chars, and treats text strictly as untrusted user data inside `PlanningContextV1.userIntent` — never concatenated into system instructions.
3. Because `TaskPlanV1` is schema-locked to allowlisted `kind` enums and validated by `TaskManager` + `ActionExecutor`, a compromised or hallucinating Ollama response **cannot** execute shell commands, read files, alter RBAC, spawn extra bots, or bypass `safetyPolicy`.

---

## 7. Security Incident Runbooks

- **Suspected `workerToken` compromise:** Run `POST /api/v1/workers/:workerId/revoke` -> fences active leases (`allocationEpoch + 1`), drops worker traffic immediately, and preserves audit log.
- **Runaway / unsafe swarm behaviour:** Click **Emergency Safe Stop** or run `swarm bot safe-stop --all` -> cancels active tasks, dispatches high-priority `safe_stop` to all workers, and halts non-survival actions within `1` poll cycle.
- **Dashboard brute-force attempt:** Automatic `(ip, username)` lockout (`429`) + rotate admin password + inspect `audit_events`.
