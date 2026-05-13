# FF4 VIR Lorebook Sync + Preset — Comprehensive Improvement Plan

## Executive Summary

The system has two interacting halves: the **ff4-vir-lorebook-sync** SillyTavern extension (stores per-character visual identity in per-chat lorebooks) and the **FF 4 MAX** preset family (instructs the AI how to use that lorebook data to generate pics). Both have critical gaps:

- The extension marks only scene-active characters as `constant: true`; all others become keyword-triggered and often never inject into context — effectively giving the AI only one character's VIR data per turn.
- The full preset's Chain-of-Thought VIR recall (Task 8) tells the AI to look inside its own `rpg` code block, not the lorebook entries — two systems fighting each other.
- The compact preset correctly references `[ACTIVE VIR]` / `[LOCKED VISUAL CARD]` lorebook format but has no equivalent of the CoT VIR recall to enforce it.
- Scene state is stored as pretty-printed JSON — token-expensive.
- No per-character priority tiers, no main-character concept, no UI for managing characters.

---

## Part 1 — Extension (`index.js`) Issues and Plans

### 1.1 Critical Bug: Only Active Characters Get `constant: true`

**Current behavior:**

`setActiveFlags(data, activeNames)` iterates all lorebook entries and sets `entry.constant = activeNames.has(name)`. `activeNames` is built from the current `<vir_sync>` packet's `new_characters` keys + `vir_delta` keys + `scene_state.active_characters` + `scene_state.characters[name].active !== false`.

In a typical established-scene sync with only scene state update:
```json
{
  "scene_state": {
    "active_characters": ["Ymir"],
    "characters": {"Ymir": {"active": true, "position": "foreground"}}
  }
}
```
Only `Ymir` is in `activeNames`. Every other character's entry gets `constant: false` and becomes keyword-triggered. If the chat doesn't explicitly mention that character's canonical name in the last N turns, their VIR never injects. The AI writes pics with zero VIR data for those characters.

**Root cause:** The binary constant/non-constant toggle is the wrong model for VIR. Characters don't disappear from visual memory just because they left the scene.

**Plan: Tiered injection with `order` priority, not constant toggling**

Replace the binary `constant` toggle with a three-tier injection strategy:

| Tier | Characters | `constant` | `order` | `depth` |
|------|-----------|-----------|---------|---------|
| A — Pinned/Main | User-pinned as "main character" | `true` | 60 | 1 |
| B — Scene-active | In current `scene_state.active_characters` | `true` | 70 | 2 |
| C — Introduced/offscreen | Known but not in scene | `false` | 80 | 3 |

Change `setActiveFlags` to use this tier logic. Add a `pinned` set stored in extension settings per lorebook/chat. Tier C characters stay keyword-triggered as now, but they inject at depth:3 which is further from prompt and causes less token pressure when not needed.

This means every scene-active character always injects (Tier B), not just one.

**Implementation:**
- Add `pinnedCharacters: {}` to `defaultSettings` (keyed by lorebook name → Set of canonical names).
- In `makeEntry`, accept a `tier` param and set `order`/`depth`/`constant` accordingly.
- In `setActiveFlags`, replace the boolean with tier logic:
  ```js
  function setActiveFlags(data, activeNames, pinnedNames = new Set()) {
      for (const entry of Object.values(getEntries(data))) {
          if (entry.comment === 'FF4 VIR Rules' || entry.comment === 'VIR_SCENE_INDEX') continue;
          const name = characterEntryName(entry);
          if (pinnedNames.has(name)) {
              entry.constant = true; entry.order = 60; entry.depth = 1;
          } else if (activeNames.has(name)) {
              entry.constant = true; entry.order = 70; entry.depth = 2;
          } else {
              entry.constant = false; entry.order = 80; entry.depth = 3;
          }
      }
  }
  ```

---

### 1.2 Token Bloat: Double Data in Character Entries

**Current behavior:**

`characterContent()` emits both:
1. A human-readable `[LOCKED VISUAL CARD: Name]` block (compact text lines)
2. The full `JSON.stringify(vir, null, 2)` — same data again, pretty-printed

For a character with 8 required fields + outfit array + accessories, this is roughly 400-600 tokens duplicated per entry. With 4 characters in a scene, that's ~2000 extra tokens of redundant data.

**Plan: Remove the JSON dump; keep only the locked card**

The locked card format already contains all necessary data for the AI to generate pics. The JSON was originally there for the AI to self-reference field names, but the `<ff4_vir_lorebook_rules>` schema entry + the preset instructions explain the format. Remove the JSON from character entries:

```js
function characterContent(name, payload = {}) {
    const vir = payload.vir || payload;
    return `[ACTIVE VIR: ${name}]\nCopy VERBATIM into every <pic> that includes ${name}.\n${lockedVisualCard(name, vir)}\n[/ACTIVE VIR]`;
}
```

If the AI needs to update VIR fields, the `<vir_sync>` delta mechanism handles that. The JSON dump is not needed at runtime.

**Token savings estimate:** ~200-400 tokens per character entry removed from context.

---

### 1.3 Token Bloat: Verbose Scene Index

**Current behavior:**

`sceneIndexContent` uses `JSON.stringify(sceneState, null, 2)` with pretty-print indentation. A typical scene state with 3 characters has ~50 lines of JSON with whitespace.

**Plan: Compact scene index format**

Use the existing `compactValue()` helper to produce a single-line scene index:

```js
function sceneIndexContent(sceneState = {}) {
    const lines = ['[VIR_SCENE_INDEX]'];
    if (sceneState.location) lines.push(`LOC: ${sceneState.location}`);
    if (sceneState.time) lines.push(`TIME: ${sceneState.time}`);
    if (sceneState.weather) lines.push(`WEATHER: ${sceneState.weather}`);
    if (Array.isArray(sceneState.active_characters) && sceneState.active_characters.length) {
        lines.push(`ACTIVE: ${sceneState.active_characters.join(', ')}`);
    }
    for (const [name, state] of Object.entries(sceneState.characters || {})) {
        const parts = [name];
        if (state.position) parts.push(state.position);
        if (state.condition && state.condition !== 'normal') parts.push(state.condition);
        if (state.outfit_state) parts.push(`outfit:${state.outfit_state}`);
        if (state.hair_state) parts.push(`hair:${state.hair_state}`);
        if (Array.isArray(state.held_items) && state.held_items.length) parts.push(`holding:${state.held_items.join('/')}`);
        if (state.injuries) parts.push(`injuries:${state.injuries}`);
        lines.push(parts.join(' | '));
    }
    if (sceneState.lighting) lines.push(`LIGHTING: ${compactValue(sceneState.lighting)}`);
    lines.push('[/VIR_SCENE_INDEX]');
    return lines.join('\n');
}
```

**Token savings estimate:** ~60-80% reduction in scene index token count.

---

### 1.4 Schema Entry Size and Placement

**Current behavior:**

`schemaContent()` generates a ~250-word `<ff4_vir_lorebook_rules>` entry with `constant: true, order: 40, depth: 1`. Depth 1 means it injects very close to the system prompt — prime token real estate. It's re-injected every turn.

**Plan: Shorten schema entry; move deeper**

Reduce schema entry to a concise reference card only. The preset itself already explains the full rules:

```
<ff4_vir_lorebook_rules>
SOURCE OF TRUTH: lorebook [ACTIVE VIR] and [LOCKED VISUAL CARD] entries for this chat.
COPY verbatim into every <pic>. No synonym-swapping. No resizing. No invention.
MISSING VIR: emit <vir_sync> new_characters packet immediately.
PERMANENT CHANGE: narrate first, then emit vir_delta with changed fields only.
MUTABLE STATE: position/condition/hair_state/outfit_state/held_items/injuries → scene_state only.
NAME LOCK: use canonical name only, no scenario/card-title suffixes.
</ff4_vir_lorebook_rules>
```

Change depth from 1 to 2 (same tier as active character entries). The preset's jailbreak already has the full rules — the lorebook schema entry is redundant detail.

---

### 1.5 Feature: Character Priority Pin UI

**Plan: Add "Pin as Main" button per character in extension panel**

Extend the extension panel UI to show a list of all characters in the current lorebook with:
- Character name
- Active/inactive status indicator (green dot = active, grey = offscreen)
- "📌 Pin" toggle button to promote to Tier A (always-constant, depth:1)
- "🗑️ Delete" button per character

Store pinned state in `settings().pinnedCharacters[worldName] = Set<string>`.

When the panel re-renders the character list, read from the lorebook entries.

---

### 1.6 Feature: VIR Completeness Indicator in UI

**Plan: Display quality warnings per character in panel**

When rendering the character list, run `assertImageReadyVir(name, payload)` on each character's stored VIR and display a warning badge if issues exist. This surfaces gaps like "hair is too short/generic" without waiting for the AI to trigger them.

Add a "🔍 Validate All" button that runs validation and shows a summary.

---

### 1.7 Feature: Manual VIR Injection Trigger

**Plan: "Remind AI" button per character**

A button that injects a system message like:
```
[VIR REMINDER: Please update your visual reference for {name}. Their [ACTIVE VIR] entry in the lorebook is the source of truth. Before your next pic, check their locked card.]
```

Useful when VIR has just been set up mid-conversation and the AI isn't using it yet.

---

### 1.8 Feature: Multi-Character Constant Override

**Plan: "Keep all in context" toggle**

A global toggle per chat: when enabled, ALL characters in the lorebook are injected as `constant: true` regardless of active status. Useful for small casts (2-3 characters) where the user wants consistent VIR for all of them always. Not appropriate for large casts (10+ characters) but the user can toggle it manually.

---

### 1.9 Bug: Scene State Not Persisted Between Packets

**Current behavior:**

When the AI sends a `<vir_sync>` with only `vir_delta` and no `scene_state`, the call to `ensureBaseEntries(data, sync.scene_state || {})` passes an empty object and overwrites the VIR_SCENE_INDEX with empty content.

**Plan: Merge scene state, not replace**

In `processSyncPacket`, load the existing scene state from the current VIR_SCENE_INDEX entry before calling `ensureBaseEntries`:

```js
async function processSyncPacket(sync) {
    const worldName = currentWorldName();
    const data = await ensureWorldLoaded(worldName);
    const activeNames = activeNamesFrom(sync);

    // Load existing scene state and merge
    const existingSceneEntry = Object.values(getEntries(data)).find(x => x?.comment === 'VIR_SCENE_INDEX');
    const existingScene = parseSceneIndex(existingSceneEntry?.content);
    const mergedScene = sync.scene_state
        ? mergeSceneState(existingScene, sync.scene_state)
        : existingScene;

    ensureBaseEntries(data, mergedScene);
    // ... rest of function
}
```

Add `mergeSceneState(existing, incoming)` that merges `characters` objects rather than replacing.

---

### 1.10 Bug: `isProcessing` Lock Drops Packets During Streaming

**Current behavior:**

`isProcessing = true` while a packet is being saved. If a second `MESSAGE_RECEIVED` fires during streaming (e.g., SillyTavern fires the event mid-stream), the second packet is silently ignored because `if (!settings().enabled || isProcessing) return`.

**Plan: Queue packets instead of dropping**

Use a simple async queue:
```js
let processingQueue = Promise.resolve();

async function enqueuePacket(messageId) {
    processingQueue = processingQueue.then(() => handleMessage(messageId)).catch(console.error);
    return processingQueue;
}
```

Replace the early-return `isProcessing` check with the queue. Multiple syncs in one streaming session are then serialized, not dropped.

---

### 1.11 Enhancement: Debug Panel with Lorebook Diff View

**Plan: Add "View Lorebook" button in debug mode**

When `debug: true`, show a panel listing all entries in the current chat's lorebook with their `constant`, `order`, `depth` values and a preview of the first 100 chars of content. Allows the user to see exactly what's injecting and at what tier without opening the SillyTavern lorebook editor.

---

## Part 2 — Full Preset (`FF 4 MAX - N PIC Realistic.json`) Issues and Plans

### 2.1 Critical: CoT Task 8 References Wrong VIR System

**Current behavior:**

The Realism CoT (enabled by default) has Task 8 with:
> "The rolling-snapshot rule guarantees the prior turn's rpg block contains the FULL ROSTER including off-scene characters (active: false) and deceased characters (status: deceased) — locate the character there before drafting."

This instructs the AI to look in its own `rpg` markdown block for VIR data. But with the lorebook extension active, VIR is in lorebook entries (`[ACTIVE VIR]` / `[LOCKED VISUAL CARD]`), not in the rpg block. The AI splits its attention between two systems, gets confused, and often reverts to inventing character appearances.

**Plan: Update all CoT VIR sections to reference lorebook format**

In the Realism CoT Task 8, replace the rpg-block VIR recall with lorebook VIR recall:

```
VIR RECALL CHECKLIST — before drafting any pic, for EACH character in the pic:
  (1) Locate their [ACTIVE VIR: Name] or [LOCKED VISUAL CARD: Name] entry in the injected lorebook context.
      System entries are injected with prefix [ACTIVE VIR:] for each known character.
  (2) List their hair, eyes, skin, body, species, permanent features verbatim from that entry.
  (3) List their current outfit state from [VIR_SCENE_INDEX] characters section.
  (4) If no [ACTIVE VIR] entry exists for a visible character, STOP: emit a <vir_sync> new_characters packet first.
  (5) Copy those values VERBATIM into the pic prompt character paragraph.
```

Remove the rpg block roster requirement from Task 8. Remove: "ROSTER PRESERVATION CHECK", "rolling-snapshot rule", and the `vir_changes` delta logic. These are extension responsibilities now.

Apply the same replacement to Freaky CoT, Novel CoT, Freaky Novel CoT, and Claude/Gemini CoT.

---

### 2.2 Missing: `<vir_sync>` Format Definition in Jailbreak

**Current behavior:**

The full preset's jailbreak does not define the `<vir_sync>` packet format. The compact preset's `<ff4_compact_execution_contract>` does define it. Without this, the AI (when using the full preset) doesn't know the exact JSON schema to emit.

**Plan: Add VIR sync section to the full preset jailbreak**

Port the VIR + Lorebook Sync section from the compact preset's jailbreak into the full preset's `jailbreak` prompt, between the Visual Output Protocol section and the RPG HUD section. This includes:
- `VIR SOURCE` paragraph (lorebook is source of truth)
- `WHEN TO EMIT <vir_sync>` list
- `SYNC PACKET FORMAT` with exact JSON template
- `VIR QUALITY FLOOR` rules
- `VIR NAME QUALITY` rules
- `NEW CHARACTER` example packet
- `PERMANENT CHANGE` / `MUTABLE STATE` rules

Keep the existing expanded VOP section from the full preset (it's more detailed than the compact), just add the sync format after it.

---

### 2.3 Enhancement: Remove Duplicate VOP Sections

**Current behavior:**

The full preset's jailbreak and several of the CoT prompts repeat VIR/VOP rules (MANDATORY PROMPT STRUCTURE, color locks, anti-bleeding rules, etc.). This causes token waste and instruction conflict.

**Plan: Consolidate VOP into jailbreak only; CoT tasks reference it**

In CoT Task 8, replace the full VOP prose repetition with:
```
Apply the MANDATORY PROMPT STRUCTURE from <visual_output_protocol> verbatim.
```

The full VOP stays in the jailbreak. The CoT tasks can reference it without duplicating it.

---

### 2.4 Enhancement: Pic Cadence Integration with VIR

**Current behavior:**

The PIC EMISSION CADENCE rules in the full preset are thorough but don't cross-reference the lorebook. When the AI decides to emit a pic, it sometimes uses stale appearance data because Task 8's VIR recall check doesn't enforce blocking until VIR is confirmed.

**Plan: Add a hard gate in Task 8**

Add to CoT Task 8:
```
HARD VIR GATE — before composing any pic:
  For each character who will appear: confirm their [ACTIVE VIR] exists in injected lorebook.
  If MISSING: do NOT generate that character's paragraph with invented values.
  Instead: add them to a <vir_sync> new_characters block first (this turn), then write the pic using those exact same values.
  Inventing appearance when [ACTIVE VIR] is missing = critical failure.
```

---

### 2.5 Enhancement: FPP Mode Toggle Integration

**Current behavior:**

The full preset has a `<pic_fpp_mode>` concept referenced in the Hybrid POV section, but the `pic_fpp_mode` prompt block is separate and currently disabled by default. The CoT checks whether `<pic_fpp_mode>` is "present in context" to determine POV.

**Plan: No change needed here** — the conditional detection in CoT Task 7/8 already handles this correctly. Document it clearly in the README prompt so users understand how to toggle FPP.

---

### 2.6 Enhancement: Narrative Entropy Integration

**Current behavior:**

Narrative entropy (stagnation detection) is only in the compact preset, not the full preset.

**Plan: Add entropy tracking to the full preset's main prompt**

Port the NARRATIVE ENTROPY section from the compact's `<ff4_compact_core>` into the full preset's main prompt:
```
NARRATIVE ENTROPY: Track stagnation. If same location/interaction/flat emotion persists 3+ turns,
inject disruption: tier 1 small at 3 turns, tier 2 medium at 4, tier 3 major at 5+.
```

---

## Part 3 — Compact Preset (`FF 4 MAX - N PIC Realistic COMPACT NonThink.json`) Issues and Plans

### 3.1 Missing: Scene-Aware VIR Injection Hint

**Current behavior:**

The compact preset's `<ff4_compact_execution_contract>` tells the AI to look for `[ACTIVE VIR]` entries but doesn't explain that the extension controls which entries are injected (active characters get `constant: true`, offscreen get keyword-triggered).

The AI doesn't know that only scene-active character VIR entries will be present in its context. It may reference characters by name in `scene_state` that have no injected VIR block.

**Plan: Add injection transparency hint**

Add to the VIR SOURCE section:
```
INJECTION NOTE: Only characters in [VIR_SCENE_INDEX] ACTIVE list are guaranteed present in context this turn.
If a character you want to pic has no injected [ACTIVE VIR], they are offscreen — do not draw them.
To make an offscreen character picable, list them in scene_state.active_characters in your next <vir_sync>.
```

---

### 3.2 Missing: HARD SHIP CHECK for Multiple Characters

**Current behavior:**

The HARD SHIP CHECK in the jailbreak lists:
> "(6) hair/outfit/accessory/body/anatomy colors and sizes match VIR exactly"

But doesn't have a per-character VIR check before writing pics, unlike the full preset's CoT Task 8.

**Plan: Add pre-pic VIR gate as a brief rule**

Add to HARD SHIP CHECK item (7):
```
(7) every visible character in every <pic> has a corresponding [ACTIVE VIR] entry in context;
    if any are missing, emit <vir_sync> new_characters this same turn before the pic.
```

---

### 3.3 Missing: Feature Parity with Full Preset

The compact preset is missing several prompts available in the full:
- VAD Emotional Matrix (dynamic emotion system)
- Anti-stiff Prose Hotfix (flow/integration mandates)
- Colored Dialogue VN (per-character dialogue color assignment)
- HQ NPC Genesis (structured NPC creation)
- NSFW Mode (explicit lexicon lock)
- Absolute Character Adherence (species vocalization, mimicry)

**Plan: Port these as optional toggle prompts into the compact preset**

Add them as disabled-by-default prompts. They're small and self-contained. Users can enable them as needed. The compact's value is the small always-on footprint — these should stay off by default.

Priority order: NSFW Mode > Anti-stiff Prose > VAD > Character Adherence > Colored Dialogue > NPC Genesis.

---

### 3.4 Enhancement: VIR Sync Packet Format — Compact Default

**Current behavior:**

The compact jailbreak shows the full verbose `new_characters` packet template. For experienced sessions where most characters are known, this encourages the AI to emit large packets for small updates.

**Plan: Add minimal-update syntax note**

After the full template, add:
```
COMPACT UPDATE (use when only scene state changes, no new/changed locked fields):
<vir_sync>
{"schema":1,"new_characters":{},"vir_delta":{},"scene_state":{"active_characters":["Name"],"characters":{"Name":{"active":true,"position":"foreground"}}}}
</vir_sync>
Omit vir_delta and new_characters entirely if only mutable state changed.
```

---

### 3.5 Enhancement: Continue Mode VIR Preservation

**Current behavior:**

The CONTINUE MODE section says "Never repeat, paraphrase, summarize, or re-emit previous assistant prose." When the user hits Continue, the AI should not re-emit pics that are already rendered. However, the AI sometimes drops VIR tracking on Continue turns because it doesn't re-read the lorebook.

**Plan: Add VIR Continue clause**

Add to CONTINUE MODE:
```
On Continue: do NOT re-emit <vir_sync> packets for unchanged characters.
DO still check [VIR_SCENE_INDEX] for active_characters before emitting any new pics this turn.
```

---

## Part 4 — Cross-Cutting Integration Improvements

### 4.1 Schema Version Handshake

**Problem:** When the preset VIR rules change (e.g., this plan's updates), old lorebooks with the old schema entry format need to be recognized and upgraded.

**Plan:** Add a `schemaVersion` field to the lorebook's FF4 VIR Rules entry content (e.g., `<!-- schema v2 -->`). When `ensureBaseEntries` detects an old version tag, log a warning in the extension status. Add a "Upgrade VIR Schema" button that refreshes the schema entry content.

---

### 4.2 Preset VIR Rules Cross-Reference

**Problem:** The `<ff4_vir_lorebook_rules>` lorebook entry and the jailbreak prompt both define VIR rules. If one is updated and the other isn't, the AI gets conflicting instructions.

**Plan:** Make the lorebook schema entry a pure reference card that defers to the jailbreak:
```
<ff4_vir_lorebook_rules>
[VIR REFERENCE ACTIVE] Full rules in jailbreak. Summary:
Copy [LOCKED VISUAL CARD] lines verbatim into every pic. Missing VIR → emit <vir_sync>. No invention.
</ff4_vir_lorebook_rules>
```

The jailbreak is authoritative; the lorebook entry is a reminder pointer only.

---

### 4.3 Group Chat Support

**Problem:** Group chats in SillyTavern have multiple character cards active. The extension currently activates one lorebook per chat, but group chats need VIR for every character in the group simultaneously.

**Plan:** When group chat mode is detected (via `getContext().groupId` being truthy), change the activation logic to ensure ALL group members' VIR entries are marked active (Tier B minimum) regardless of `scene_state`. This prevents the single-character bottleneck in group roleplay contexts.

---

### 4.4 VIR Auto-Request on Chat Start

**Problem:** At the start of a new chat, the lorebook is empty. The AI writes the first message without any `[ACTIVE VIR]` entries available, and often doesn't emit a `<vir_sync>` unless the jailbreak explicitly triggers it.

**Plan:** When `activateCurrentWorld()` runs and the lorebook has zero character entries (only system entries), inject a one-time system message reminder:
```
[FF4 VIR] No character VIR registered for this chat yet. 
If characters appear in this scene, emit <vir_sync> new_characters for each one in your first response.
```

This is a SillyTavern toast/banner, not an injected chat message. It reminds the user to watch for the first sync packet.

Alternatively: add a setting "Inject VIR reminder on empty lorebook" that adds a `hidden: true` system message at the bottom of the context.

---

## Part 5 — Implementation Priority Order

| Priority | Item | File | Effort |
|----------|------|------|--------|
| P0 | 1.1 Tiered injection (fix core "1 character" bug) | index.js | High |
| P0 | 2.1 Fix CoT Task 8 VIR system reference | Full preset | Medium |
| P1 | 1.2 Remove JSON dump from character entries | index.js | Low |
| P1 | 1.3 Compact scene index format | index.js | Low |
| P1 | 2.2 Add `<vir_sync>` format to full preset jailbreak | Full preset | Medium |
| P1 | 3.1 Injection transparency hint in compact jailbreak | Compact preset | Low |
| P2 | 1.4 Shorten/reposition schema entry | index.js | Low |
| P2 | 1.5 Character priority pin UI | index.js | Medium |
| P2 | 1.9 Scene state merge (not replace) | index.js | Medium |
| P2 | 2.4 Hard VIR gate in CoT Task 8 | Full preset | Low |
| P2 | 3.2 HARD SHIP CHECK item (7) VIR gate | Compact preset | Low |
| P3 | 1.6 VIR completeness indicator in UI | index.js | Medium |
| P3 | 1.10 Queue instead of drop during streaming | index.js | Medium |
| P3 | 1.8 Multi-character constant override toggle | index.js | Low |
| P3 | 3.3 Port feature prompts to compact preset | Compact preset | High |
| P3 | 2.6 Narrative entropy in full preset | Full preset | Low |
| P4 | 1.7 Manual VIR injection trigger | index.js | Low |
| P4 | 1.11 Debug lorebook diff view | index.js | Low |
| P4 | 4.1 Schema version handshake | index.js | Low |
| P4 | 4.3 Group chat support | index.js | Medium |
| P4 | 4.4 VIR auto-request on chat start | index.js | Low |

---

## Part 6 — What "Good" Looks Like After Implementation

**For a scene with 3 characters (e.g., ETS, Ymir, Marah):**

1. First sync packet introduces all 3 via `new_characters`.
2. Extension creates 3 lorebook entries. All 3 are in `active_characters` → all 3 get Tier B (`constant: true, order:70, depth:2`).
3. Every subsequent turn: all 3 `[ACTIVE VIR]` entries inject into context. The AI sees all 3 locked visual cards.
4. AI generates a pic with 3 characters: it reads all 3 locked cards and writes accurate character paragraphs for all 3.
5. Marah leaves the scene. Next sync packet has `active_characters: ["ETS", "Ymir"]` and `characters: {"Marah": {"active": false}}`.
6. Extension moves Marah to Tier C (`constant: false, order:80, depth:3`). She still injects if her name appears in context but doesn't burn constant token budget.
7. User pins ETS as "main character" via the extension panel → ETS becomes Tier A (`constant: true, order:60, depth:1`) and always injects near the top of the lorebook context.

**Token budget impact for 3 characters with compact entries:**
- Old: ~600 tokens/char × 3 = ~1800 tokens + 200-token schema + 150-token scene index = ~2150 tokens
- New: ~300 tokens/char × 3 = ~900 tokens + 80-token schema + 60-token scene index = ~1040 tokens
- Savings: ~1100 tokens freed per turn for chat history / more characters
