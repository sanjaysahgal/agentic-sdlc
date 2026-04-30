# Disaster Recovery runbook

> Block L2 of the approved system-wide plan
> (`~/.claude/plans/rate-this-plan-zesty-tiger.md`). Step-by-step
> playbooks for catastrophic failure modes. Tested quarterly per the
> Block L1 backup cadence.

## Failure mode → playbook index

| Failure | Severity | Playbook |
|---|---|---|
| Full state loss (state files deleted/corrupted) | Medium | §1 |
| GitHub token revoked / customer rotates | Medium | §2 |
| Anthropic API outage | Low | §3 |
| Slack workspace deauth / token revocation | High | §4 |
| Host process killed and won't restart | High | §5 |
| `tsx watch` silent reload failure | Low | §6 |
| Production code reverted on deploy | High | §7 |

---

## §1 — Full state loss

**Symptom:** `.conversation-state.json`, `.confirmed-agents.json`, and/or
`.conversation-history.json` are missing or empty after a restart.

**Impact:** Pending escalations, approvals, decision reviews, and thread
↔ agent mappings are lost. Spec drafts and approved specs in GitHub are
unaffected (they're the authoritative source, see ADR-0003 / Principle 1).

**Recovery:**
1. Restore from the most recent daily backup if available (Block L1).
2. If no backup is available, accept the loss. The platform starts fresh:
   - Per `parseConversationState` (Block D2), the bot will not crash on
     missing or malformed state files.
   - Active threads will lose their pending state. Users may see the
     agent re-prompt for things that were already in flight — they should
     re-confirm.
3. Notify customers via the operator runbook's "Manual tester says ..."
   playbook so they know to re-confirm in-flight escalations.
4. File a postmortem: how did the state file get lost? File-system issue?
   Bad delete? Block K (durable storage backend) is the long-term fix.

---

## §2 — GitHub token revoked / customer rotates

**Symptom:** Spec saves fail with 401. `[STORE]` and `[ROUTER]` logs
continue but `[ESCALATION]` writebacks fail; users see "spec save failed."

**Recovery:**
1. Customer issues a new PAT with the required scopes (see
   `docs/CUSTOMER_ONBOARDING.md` §4).
2. Update `GITHUB_TOKEN` in the deployment's secret store.
3. Restart the bot.
4. Verify via MT-9 (PM draft save) — saves resume.

---

## §3 — Anthropic API outage / 529

**Symptom:** `withThinking` posts the actionable error message ("the AI
is overloaded — please retry in a moment") instead of the agent's
response. `[THINKING-ERROR]` log lines appear.

**Recovery:**
1. No platform action — Anthropic 529 typically clears in seconds to minutes.
2. Deterministic gates (audits, hedge gate, action verifier) are unaffected
   per Principle 11 — they have no LLM dependency.
3. Users can retry. State is uncorrupted (`pendingApproval` etc. only set
   on successful turns).

---

## §4 — Slack workspace deauth / token revocation

**Symptom:** All Slack API calls return 401. Bot appears offline; no
messages posted; no slash commands handled.

**Recovery:**
1. The customer's Slack admin must re-install the app to the workspace.
2. New `xoxb` and `xapp` tokens generated.
3. Update `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in the secret store.
4. Restart the bot. Verify with `/pm` in any feature channel.

**Customer-visible impact:** silent during the outage window. Users may
have sent messages that the bot never processed — those are lost (Slack
doesn't replay).

---

## §5 — Host process killed and won't restart

**Symptom:** `pgrep -f "tsx.*server.ts"` returns nothing; `npm run dev`
exits immediately with an error.

**Recovery:**
1. Check the most recent log file for the failure cause:
   `tail -100 logs/bot-$(date +%Y-%m-%d).log`. Common causes:
   - Missing env var (loadWorkspaceConfig throws on startup)
   - Port conflict (Slack Bolt uses port 3000 by default)
   - Node version mismatch (requires Node 20+)
2. Fix the environmental issue.
3. `npm install` if `node_modules/` is suspect.
4. `npm run dev` again. Verify `[BOOT]` log line appears within 10 seconds.

**Escalation:** if the bot won't start after env vars are confirmed correct
and Node 20 is verified, file an incident: include the full startup log,
`git rev-parse HEAD`, and `node --version`.

---

## §6 — `tsx watch` silent reload failure

**Symptom:** Code change pushed, manual tester reports the bug still
reproduces. The fix author confirms the file is correct on disk.

**Recovery:**
1. Verify the bot's `[BOOT]` line: `tail -1 logs/bot-$(date +%Y-%m-%d).log
   | grep "\[BOOT\]"`. Compare `commit` with `git rev-parse --short HEAD`
   and `codeMarker` with `runtime/boot-fingerprint.ts`.
2. If either differs, tsx-watch silently failed to reload. Hard restart:
   `kill -9 $(pgrep -f "tsx.*server.ts" | head -1) && npm run dev`.
3. Re-verify `[BOOT]`.

**Prevention:** Block J3 (`[CODE_MARKER BUMP GATE]`) ensures every
production-wiring fix bumps `CODE_MARKER`, so the manual tester always
has a contract to verify before running the scenario.

---

## §7 — Production code reverted on deploy

**Symptom:** A fix that was in `main` is no longer running in production.
`git log` shows the commit landed; `[BOOT] commit=<sha>` shows an older SHA.

**Recovery:**
1. The deploy mechanism either reverted or didn't pull the latest. Force
   a pull: `git pull origin main` in the deploy environment.
2. Restart the bot. Verify `[BOOT] commit=` matches `main`.
3. Postmortem: what reverted? Bad CI rollback? Manual `git checkout` left
   the deploy on an old SHA?

**Long-term:** wire up immutable deploys (build artifact tagged with
commit, deploy by SHA not branch). Block K storage migration is a natural
point to also formalize the deploy pipeline.

---

## Quarterly DR drill

Per Block L1, run a full DR drill quarterly:
1. Take a backup snapshot.
2. Stop the bot.
3. Delete `.conversation-state.json` and the most recent backup.
4. Start the bot. Verify it boots cleanly.
5. Run MT-12 (concierge orientation) + MT-15 (first-time-user orientation)
   — both should succeed despite the state loss.
6. Restore the state from the snapshot taken in step 1.
7. Verify pending state (escalations, approvals) returns.

Document the drill outcome in `docs/dr-drill-log.md` (one line per drill).
