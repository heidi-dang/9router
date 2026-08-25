# Antigravity Production Runbook

## Scope and ownership

The Antigravity production path has one account-routing authority: `src/sse/services/antigravityCoordinator.js`. Public Chat Completions, Responses, Anthropic Messages, and authenticated Anthropic `count_tokens` requests must obtain Antigravity credentials, project state, and account outcome handling through this coordinator. The legacy generic credential selector remains the path for non-Antigravity providers only.

| Surface | Request normalization | Account control plane | Upstream operation |
|---|---|---|---|
| OpenAI Chat / Responses | Canonical translator | Coordinator | Antigravity executor `generateContent` |
| Anthropic Messages | Canonical translator | Coordinator | Antigravity executor `generateContent` |
| Gemini-native | Canonical translator | Coordinator | Antigravity executor `generateContent` |
| Anthropic `count_tokens` | Claude-to-Antigravity translator | Coordinator | `v1internal:countTokens` |

## Account state and retry policy

The coordinator uses opaque account identities, session affinity, active-connection discovery, bounded in-flight fairness, and a finite failure taxonomy. It does not write OAuth tokens, project identifiers, or raw upstream bodies to diagnostic state. Account outcomes are persisted only as bounded categories such as temporary, quota, credit, authentication, project, or deterministic input failure.

| Condition | Account action | Request behavior |
|---|---|---|
| 400-class deterministic schema/input error | Do not poison account | Return failure; do not rotate merely for bad input |
| 401/403 refreshable authentication failure | Refresh once when eligible, then mark authentication state | May try another eligible account within the bounded plan |
| 429 or explicit quota signal | Record cooldown with parsed, clamped reset | Skip cooled-down account |
| Explicit exhausted credit state | Mark exhausted | Rotate to an eligible account |
| Recoverable project error | Invalidate project, rediscover once | Retry that candidate exactly once |
| Network/5xx temporary failure | Record temporary state | Proceed only while account and upstream budgets remain |

A coordinator attempt has a global upstream-dispatch allowance of two requests. The executor enforces this cap across status and network retries on the single selected endpoint, preventing account selection multiplied by per-endpoint retry loops from becoming an unbounded request fan-out. Equivalent endpoint retries reuse the already transformed request payload. Client cancellation aborts retry backoff and disconnecting a streamed client cancels its upstream body.

## Endpoint and proxy behavior

Chat generation health-selects one configured endpoint before dispatch. It does not cross-fallback to another endpoint after dispatch, so a session-bound or partially accepted request is never replayed against a different host. Discovery, project, and quota APIs remain production-only. Connection proxy resolution belongs to the active connection and is applied through the common transport. A strict proxy configuration must fail closed: it must not silently fall back to a direct connection. No proxy URL, access token, authorization header, or upstream response body is allowed in logs, state, or reports.

## Model routing

Explicit `antigravity/<model>` and `ag/<model>` prefixes select Antigravity. Unprefixed `gemini-*` models retain ordinary Gemini ownership. Explicit `gemini/<model>` and Gemini CLI `gc/<model>` also retain their configured owners; they must not be captured by Antigravity routing. The static catalog is a compatibility list, not an assertion that every account is entitled to every model. Live availability is discovered only through authenticated upstream calls.

## Deterministic release gate

Run the focused gate before merging or deploying changes that touch this path:

```bash
npm run verify:antigravity
```

The gate runs coordinator, lifecycle, protocol, routing, quota, retry, count-token, project-redaction, and streaming-disconnect tests, then the repository production build. It must exit successfully. A passing deterministic gate is not evidence that an unauthenticated local environment can reach the provider.

For investigation, run the focused test suite alone:

```bash
npm run test:antigravity
```

## Live acceptance policy

Live validation is permitted only when all three legitimately provisioned variables are present: `RUN_REAL`, `AG_URL`, and `AG_KEY`. Do not invent placeholders, reuse browser credentials, scrape credentials, or print environment values. If any variable is absent, report the live status as **BLOCKED** and retain the deterministic results. Live test output must report only status, endpoint class, model, and opaque failure category.

## Incident checklist

First verify `npm run test:antigravity` and inspect only redacted application diagnostics. Confirm whether the failure is deterministic input, authentication, project discovery, quota, credit, temporary transport, or cancellation. For account-specific states, inspect opaque health records and cooldown expiry; never expose account identifiers or OAuth material in an incident ticket. For proxy incidents, verify strict-proxy configuration on the active connection and test reachability through approved operations rather than disabling strict mode. Do not clear all account health state as a first action: targeted expiry and the coordinator’s bounded recovery paths protect healthy accounts from a bad request.

## Evidence expectations

A release record should contain the feature-branch commit, official-reference commit, exact deterministic command totals, build status, an explicit `PASS`, `FAIL`, `BLOCKED`, or `SKIP` live status, and any remaining limitations. It must distinguish local deterministic evidence from a real provider acceptance result.
