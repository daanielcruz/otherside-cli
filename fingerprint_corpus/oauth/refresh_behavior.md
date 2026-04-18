# Refresh behavior — observed 2026-04-17

Claude Code 2.1.113 performs token refresh **proactively based on expiresAt**, NOT reactively on 401 response.

## Evidence

### Test A: invalidate access_token, leave expiresAt in the future
- Edited `~/.claude/.credentials.json`: set `accessToken` to `INVALIDATED_BY_OTHERSIDE_CAPTURE`, left `expiresAt` at original future value
- Ran `claude -p "hi 2"`
- Result: HTTP 401 "Invalid bearer token" surfaced to user — Claude Code did NOT attempt refresh
- Conclusion: Claude Code trusted `expiresAt` and did not retry on 401

### Test B: invalidate access_token AND set expiresAt to past
- Same `accessToken` state as Test A
- Set `expiresAt` to `now - 1 hour` (epoch ms)
- Ran `claude -p "hi refresh test"`
- Result: Claude Code hit `POST /v1/oauth/token` with `grant_type=refresh_token` BEFORE calling `/v1/messages`, got new token pair, then proceeded with inference
- Conclusion: refresh is triggered by local `expiresAt` check

## Implications for otherside

**Match Claude Code's behavior** (per D6 fingerprint rule — always impersonate upstream):

- Check `expiresAt` locally BEFORE every request to a provider endpoint that requires auth
- If expired (or within a safety margin, e.g. 60s), do refresh FIRST, then issue the actual request with the new token
- Do NOT attempt refresh on 401 — 401 surfaces to the user as auth error (direct user to `otherside login --provider X`)

**Previous assumption (wrong)**: the initial auth spec draft said "attempt refresh on 401 and retry once". Observed behavior is different. Spec delta at `openspec/changes/001-mvp-anthropic-hello/specs/auth/spec.md` should be updated to reflect proactive-only refresh.

## Credentials file shape (`~/.claude/.credentials.json`)

```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1776496563992,
    "scopes": [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code"
    ],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_20x"
  }
}
```

Top-level key `claudeAiOauth` — suggests other OAuth "types" may exist (consoleOauth? apiKey?). CamelCase (not snake_case). `expiresAt` is epoch milliseconds. `scopes` is an array preserved in what looks like stable order (matches request-body scope order in refresh: profile, inference, sessions:claude_code, mcp_servers, file_upload — but stored here alphabetized... actually matches the cached-from-response alphabetical order).

Local-cached `subscriptionType` and `rateLimitTier` come from the `/api/oauth/profile` response, not from the OAuth token response itself.
