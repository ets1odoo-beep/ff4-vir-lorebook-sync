# FF4 VIR Lorebook Sync — Remaining Work

**Current shipped version:** 6.2.1
**Scope of this document:** items that are NOT done yet. Anything that has shipped in v6.0.0 or v6.1.0 has been removed from this file. See git history / commit messages for what was completed.

---

## Shipped in v6.2.0

- Per-chat template override stored in `chat_metadata`, with a global template default still available.
- Per-chat FF4 VIR disable stored in `chat_metadata`, with runtime gating across activation, contract injection, packet parsing, and DOM cleanup.
- UI section for per-chat overrides in the settings panel.
- `/vir-template` now targets the current chat by default and accepts `--global` for the global default.
- Added `/vir-disable` and `/vir-enable` for current-chat control.

---

## Shipped in v6.2.1

- Chat-lore conflict handling now prompts for a decision instead of silently taking the slot:
  - switch FF4 VIR to global mode
  - merge FF4 VIR entries into the existing chat lorebook
- Attach/detach notifications added for dedicated FF4 VIR chat-lore operations.
- Merged chat-lore mode no longer clears the user's existing chat-lore attachment when FF4 VIR is disabled.

---

## 1. Critical follow-up — verify v6.1.0 in production

Smoke checks the user should run within the next few sessions to catch any regression introduced by the v6 line of changes.

- [ ] **Recall decay actually decrements every turn.** Pin a character. Mark them off-scene at turn N with `recall=8`. At turn N+8, check `extension_settings['ff4-vir-lorebook-sync'].recallCharacters[<world>]` — the counter must visibly decrement each turn and the entry must disappear at zero.
- [ ] **Two lorebook entries exist after a chat is opened.** Open any chat with the extension enabled. In ST's Lorebook UI, look at the bound `FF4 VIR - <chat>` world. You should see entries `FF4 VIR Rules` (constant=true, no keywords) and `FF4 VIR Recovery` (constant=false until parse miss).
- [ ] **Off-scene NPCs cost zero tokens until mentioned.** Add 10+ NPCs to a session. Sample the actual prompt (ST → Connection Profile → Inspect Prompt). Only Pinned + Active(scene) + Recall + Rules entries should appear. Mention an off-scene NPC's name → next prompt should now include that entry.
- [ ] **Template-mismatch badge fires correctly.** Switch template from Detailed → Compact. Existing entries should show `↻ Compact?` badge. Click 🔄 on one → badge clears.
- [ ] **Refresh button works against the installed ST build.** v6 uses `getContext().generateRaw()`. If ST changes the signature in future, the fallback positional call kicks in. Watch for the "generateRaw failed" toastr — if it ever fires, the fallback needs updating.
- [ ] **Refresh cooldown actually locks the button.** Click 🔄 on a character; button should be greyed out for 30 seconds (or whatever the cooldown slider is set to) before being clickable again. Tooltip should show remaining seconds.
- [ ] **Batch refresh ("Refresh all chars") iterates without losing entries.** Run it on a roster of 5+ characters; verify each entry ends up in the active template's shape and no entry is dropped or corrupted.
- [ ] **Refresh context-turns slider actually changes how much chat tail the AI sees.** Set slider to 5; refresh a character; check the request payload in DevTools Network — should only see ~5 recent messages. Set to 50; should see ~50.
- [ ] **`/vir-template <Compact|Standard|Detailed>` slash command switches global template** and updates the settings UI select. Existing entries don't auto-rerender (correct behaviour).
- [ ] **Hover popover** appears when mousing over a character row and shows the actual lorebook entry text.
- [ ] **Listener count stays bounded.** Toggle the extension off and on twice in the same session. In DevTools, inspect ST's eventSource. There should be at most ONE handler per event type, never multiplying.

---

## 2. P2-11 — Replace `isProcessing` with a packet queue (deferred)

**Status:** the `isProcessing` flag from the original v5.x audit no longer exists in code, but `processingQueue` is still declared at the top of `index.js` (unused). If streaming generations ever overlap with rapid swipes/regenerates, packets could be dropped silently.

**Why deferred:** in real-world testing this hasn't surfaced as a problem — the dominant pattern is one `GENERATION_ENDED` → one packet → one save. Adding a proper queue is non-trivial and has been postponed until a user reports an actual race.

**If you decide to do it:** chain incoming packets via `processingQueue = processingQueue.then(() => processMessageData(messageId))` instead of the current direct-call pattern. Tracks all in-flight processing and serializes saves. Estimated ~45 min.

---

## 3. Remove `setExtensionPrompt` paths entirely (v6.2 cleanup)

v6.0.0 / v6.1.0 keep `injectVirContract()` as a redundant safety net even though the contract is now also stored in the `FF4 VIR Rules` lorebook entry. Once a few weeks of production use confirms the lorebook path works reliably on all ST builds, the `setExtensionPrompt` calls in `injectVirContract` / `clearVirContract` can be deleted.

**Why deferred:** caution. Removing redundancy too fast risks a silent regression on an ST build we haven't tested.

**Target:** v6.2.0. Trigger condition: zero parse-miss reports related to "rules not visible to AI" for two weeks.

**Side benefit when removed:** the `FF4_VIR_CONTRACT` / `FF4_VIR_PRIORITY` / `FF4_VIR_STATE` slot clearing code at `clearVirContract()` becomes pure cleanup (just clears the lorebook entry's `constant` flag instead of poking ST's prompt slots).

---

## 4. Refresh-button polish that didn't ship in v6.1

The v6.1 Refresh flow covers batch + debounce + context slider + telemetry + hover preview. Items left:

- [ ] **Undo last refresh** — keep a one-deep history of `entry.content` so a bad refresh can be rolled back. Right-click → "Undo refresh", or a dedicated ↶ icon next to 🔄.
- [ ] **Estimated token cost in the button tooltip BEFORE click.** Currently the tooltip says what the button does, not what it will spend. The estimate is computable from `(existingEntry.length + buildChatTailForRefresh().length + ~256) / 4`. Show this number in the tooltip when not in cooldown.
- [ ] **Diff-only refresh mode** (cheaper alternative to full refresh) — send the existing entry as `[CURRENT]` and ask only "what changed in the last N turns?". Saves AI output tokens; less risk of catastrophic identity loss. Likely a separate "🔁 Diff refresh" button alongside the full 🔄.

**Why partially deferred:** undo + diff mode add storage and a second AI path; not load-bearing.

---

## 5. Conditional injection gates (from `peak_rp_plan.md`)

The peak_rp_plan.md design called for content-type gates that default OFF and only activate when relevant:

- `NSFW gate` — only injects sex-act / nudity tracking rules when the scene actually warrants them.
- `Power Dynamics gate` — only injects domination / submission tracking when relevant.
- `Edging gate` — sex-pacing-specific rules.
- `Combat gate` — wound / posture / weapon tracking only during combat.

**Implementation outline:**

1. Add a `gates` array to settings: `[{ name: 'NSFW', keywords: [...], rules: '...' }]`.
2. On each generation, scan the recent chat tail for the gate's trigger keywords.
3. If any gate matches, append its rules block to the `FF4 VIR Rules` content (or maintain a separate `FF4 VIR Gate: <name>` lorebook entry with `constant=false` and the trigger keywords as `key[]`).

**Why deferred:** this is a substantial design slice. Needs answers to several of the 25 questions in `peak_rp_plan.md` before proceeding.

**Estimated effort:** ~6 hours including the keyword detection + per-gate rules content + settings UI.

---

## 6. Preset compression (out of code-side scope)

The peak_rp_plan.md notes that the FF4 MAX preset is ~24k characters and could be compressed to ~4k with telegraphic syntax without losing meaning for the AI. This is **preset-side** work (editing the OpenAI Settings JSON), not extension code. Tracked here for visibility only.

---

## 7. Resolve 25 design questions in `peak_rp_plan.md`

`peak_rp_plan.md` ends with 25 open design questions (Q1–Q25) that the author flagged as needing user input before the broader Phase 0–7 redesign can proceed. Most of these gate the conditional-injection-gates work in §5. Until they're answered, the extension stays at v6.x.

**Action:** read `peak_rp_plan.md` end-to-end, answer the 25 questions, then come back to §5.

---

## 8. Still-open decisions from earlier planning

Minor knobs that need confirmation but don't block any concrete work:

1. **Compact template — keep `dialogue_color`?** Currently dropped from Compact (saves ~10 tokens per char). If you actually use dialogue colouring with Compact entries, set `voice_lock.dialogue_color` to be retained.
2. **Detailed overflow drop order** — when a character genuinely exceeds 256 tokens (rare), the renderer falls back to Standard then Compact. Current drop order: `body_material → brow_lash → lips_teeth → hands_feet → marks → extra accessories → extra equipment`. Confirm acceptable, or specify another order.
3. **Auto-migration on v6 → v6.x** — when a future renderer change requires re-rendering all existing entries, should the extension do it silently on load, or prompt the user once? (For 6.0 → 6.1 the answer was "no auto-rerender; user clicks 🔄 manually". Same default for future patches?)
4. **Backups on schema migration** — should v6.x write a one-time backup of every FF4-VIR world before any breaking renderer change? (Current answer: no — relying on ST's existing world backup.)
5. **Per-world template override** — different chats might want different templates. Resolved in v6.2.0 via per-chat metadata override instead of a world-name map.

---

## 9. Future hardening / nice-to-haves (low priority)

- [ ] **Token-budget telemetry in diagnostics** — extend the existing per-row telemetry chip into a full diagnostics row showing average / median / worst entry size across the roster.
- [ ] **`/vir-pin` chat tooltip / autocomplete** — currently the slash commands work but don't autocomplete character names. Could surface known names via ST's slash-command enum-provider hook.
- [ ] **Export only-active subset** — `/vir-export-active` that dumps just the currently-injected entries (pinned + active + recall), useful for sharing scene state.
- [ ] **Drop `setExtensionPrompt` once §3 ships** — once removed, the FF4_VIR_CONTRACT slot is gone, simplifying the codebase further.
- [ ] **Compact slash-command help table** — `/vir-help` that prints a one-screen reference of all `/vir-*` commands.

---

## Definition of "done" for this document

Each item above either:

- gets implemented and removed from this file, or
- gets explicitly closed as won't-do with the reason recorded in commit messages.

Anything in this file at any given time is open work.
