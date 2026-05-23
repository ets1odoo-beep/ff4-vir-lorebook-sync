# FF4 VIR Lorebook Sync

**Visual Identity Registry (VIR) tracking for long-form SillyTavern roleplay.**

VIR keeps every character's appearance consistent across a whole story — and across every generated image. The AI emits a compact tracker block at the end of each reply; this extension parses it, stores each character as a structured lorebook entry, and injects only the relevant characters back into context. The result: a character described in message 5 still looks identical in message 500, and every `<pic>` tag renders them the same way.

---

## What problem it solves

In a long RP, character appearance drifts. The model forgets the exact hair colour, the outfit, the scar on the left cheek. Image generation makes it worse — each `<pic>` re-invents details the prose didn't restate.

VIR fixes this by maintaining a **single source of truth** per character:

- **Immutable identity** — species, hair, eyes, body, marks. Set once, copied verbatim into every pic forever.
- **Current state** — what they're wearing/holding right now, current pose, hairstyle, visible condition (sweat, fluids, injuries). Updated the moment it changes.

Every `<pic>` tag copies from the VIR entry, so two images generated hours apart render the same character.

---

## How it works

1. **Contract injection** — the extension injects a VIR contract into every generation (no preset edit needed). It tells the model how to emit the tracker block and what detail each field needs.
2. **The AI emits a `` ```vir `` block** at the end of its reply — flat JSON, schema 3.
3. **The extension parses it** and creates/updates one lorebook entry per character (`VIR: <name>`).
4. **The tracker block is stripped** from the visible chat so prose stays clean.
5. **Smart tiers** decide which character entries are injected into context (see below).

---

## The tier system

Not every tracked character should sit in context every turn — that wastes tokens. VIR sorts characters into 4 tiers, re-evaluated every reply:

| Tier | Meaning | In context? |
|---|---|---|
| **PINNED** | Always-relevant characters (the user persona, recurring leads) | Always injected |
| **ACTIVE** | Characters in the current scene | Always injected |
| **RECALL** | Characters who recently left the scene — decays over N turns | Injected until decay expires |
| **OFFSCREEN** | Everyone else | Keyword-only — zero token cost until their name appears in chat |

With **Smart dynamic tiers** on (recommended), offscreen characters cost nothing until mentioned. Turn it off and every character is always injected (simpler, heavier).

Slash commands: `/vir-pin <Name>`, `/vir-recall <Name>`, `/vir-park <Name>`, `/vir-list`, `/vir-status`.

---

## User persona tracking

The AI never emits a VIR block for `{{user}}` — it only describes NPCs. So your own character was never tracked.

With **Track user persona** enabled (default on), the extension reads your active persona description, extracts a best-effort VIR, and seeds a **pinned** entry. The AI can then enrich it over time via updates. Re-seeds automatically when you switch personas. It won't overwrite an entry the AI has already enriched.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| **Enabled** | on | Master toggle. Off = no extension activity. |
| **Smart dynamic tiers** | on | Offscreen characters are keyword-only (zero token cost until named). Off = every character always injected. |
| **Auto-hide synced packets** | on | Strips the `` ```vir `` block from visible chat so prose stays clean. |
| **Auto-inject contract + state** | on | Injects the VIR contract + current state every generation. No preset edit needed. |
| **Track user persona ({{user}})** | on | Auto-seeds a pinned VIR entry from your active persona description. |
| **Bind lorebook to current chat** | on | Stores the VIR lorebook reference in chat metadata so it re-activates on reopen. |
| **Delete VIR lorebook when chat deleted** | on | Cleans up orphaned VIR lorebooks. |
| **Debug logging** | off | Verbose console logs + toasts for troubleshooting. |

---

## The `` ```vir `` block (schema 3)

The AI emits this as the last thing in its reply:

```
​```vir
{"schema":3,"characters":[{"name":"Misty","action":"update","hair_state":"wet, clinging to her shoulders","condition":"flushed, light sheen of sweat","outfit":"none — undressed"}],"scene":{"location":"Bathroom","time":"Morning","active":"Misty"},"states":[{"name":"Misty","position":"kneeling in the tub","aftermath":0}],"recall":[]}
​```
```

**`characters[]`** — one flat object per character. `action: "create"` on first appearance (emit all fields), `action: "update"` afterward (emit only what changed).

**Per-character fields:**

*Immutable* (set once on create): `species`, `source`, `age_appearance`, `height`, `build`, `body_material`, `hair`, `eyes`, `face_features`, `skin`, `body`, `marks`, `non_human`.

> **`body_material` is mandatory for non-humans.** A slime girl is not a human with coloured skin — she's translucent gel with no skeleton. A dryad is living wood and bark, not green skin. Without `body_material`, the image generator defaults every body to solid human flesh and you get slime girls with hard bodies, dryads with human bodies. Leave it empty only for ordinary humans.

*Current state* (update whenever it changes): `hair_state`, `outfit`, `underwear`, `accessories`, `equipment`, `holding`, `pose`, `expression`, `condition`, `location_context`.

Multi-piece fields (`outfit`, `accessories`, etc.) are semicolon-separated strings: `"cream turtleneck; dark jeans; tan boots"`.

**`scene`** — `location`, `time`, `active` (comma-separated names in the current scene).

**`recall`** — names of characters who just left; they stay in context for N turns then decay.

---

## Why field detail matters

The VIR is what every `<pic>` tag copies from. Vague fields = the image generator invents something different each time.

| Field | Vague (bad) | Specific (good) |
|---|---|---|
| hair | "blonde hair" | "ash-blonde, mid-back length, fine straight, blunt fringe" |
| eyes | "grey eyes" | "pale grey, almond, slightly downturned" |
| outfit | "casual clothes" | "cream wool turtleneck; dark-wash skinny jeans; tan ankle boots" |
| condition | "messy" | "smudged lipstick; bruise forming on left cheek; light sheen of sweat" |
| body_material (slime) | "blue skin" | "whole body translucent blue-green gel, jiggly, no skeleton, deformable, light refracts through her" |
| body_material (dryad) | "green skin" | "living wood and bark torso, mossy joints, leaf-and-vine hair, twig-tip fingers" |

The injected contract instructs the model to be this specific. The richer your preset's vir rules, the better.

---

## Troubleshooting

**A character isn't being tracked.**
Open the extension panel → check "Last sync". If it says "0 characters tracked — check the preset vir schema", the AI is emitting a malformed block. The block must be flat name-keyed objects (schema 3), not nested. Make sure your preset includes the vir schema instructions.

**My user persona isn't tracked.**
Confirm "Track user persona" is on, and that your active persona actually has a description (Persona Management panel). An empty persona description can't be seeded.

**Entries look thin / vague.**
The VIR is only as detailed as what the AI emits. The injected contract instructs the model to be specific, but a weak model may still emit vague fields. Pinned/active entries can be hand-edited in the World Info editor.

**Duplicate entries for the same character.**
Usually a name-canonicalization miss — "Misty" vs "Misty (Netori)". Use `/vir-list` to see all tracked names; merge by editing the lorebook.

**Images still inconsistent.**
The `<pic>` tags must actually copy from the VIR card. Check that your image preset's pic-prompt instructions reference the `[ACTIVE VIR: Name]` block.

**Non-human characters render wrong** — slime girl with a solid body, dryad with human skin, random skin colours.
The character's `body_material` field is empty or vague. Open the character's VIR entry in the World Info editor and check the `BODY_MATERIAL:` line. It must describe the actual substance ("translucent gel, no skeleton" / "living wood and bark"), not just a colour. If the AI keeps emitting it vague, your preset's vir rules need to stress `body_material` for non-humans — the injected contract already demands it, but a weak model may still skip it.

---

## Installation

1. Copy `ff4-vir-lorebook-sync` into `data/default-user/extensions/` (or install via the extension URL).
2. Restart SillyTavern.
3. Enable in the Extensions menu.

## Requirements

- SillyTavern 1.12.0 or higher.
- A preset that emits `` ```vir `` blocks (FF4-style). The contract injection covers the format; preset-level detail rules are optional.

---

**Author:** [ets1odoo-beep](https://github.com/ets1odoo-beep)
**Version:** 5.2.0
