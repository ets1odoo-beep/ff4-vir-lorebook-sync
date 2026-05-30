// FF4 VIR Lorebook Sync — v6.2.1 (chat lore conflict resolution + merged-mode safety)
// v6 changes:
//   - SillyTavern owns ALL injection. The extension only writes lorebook entries
//     with tier flags (constant/order/depth/key[]); ST decides what gets injected
//     based on its native keyword-gating engine.
//   - Three templates with strict per-character token caps: Compact (≤128 tok),
//     Standard (≤192 tok), Detailed (≤256 tok). Renderers enforce the budget.
//   - Per-character Refresh button (one-off AI generation to re-emit in current
//     template) replaces per-character template override (which confused the AI).
//   - Recall decay now persists every turn (was only saved on expiry).
//   - Listeners are idempotent across re-init.
//   - Sparse-entry detection lets delta updates backfill corrupted bases.
//   - worldInfo load failures surface to the user instead of silently
//     overwriting with empty data.
// AI emits ```vir code-fence blocks; extension parses, updates lorebook entries
// dynamically (smart tier system), strips JSON from visible chat.

import { extension_settings, getContext } from '../../../extensions.js';
import {
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    name1,
    saveMetadata,
    saveSettingsDebounced,
} from '../../../../script.js';
import { power_user } from '../../../power-user.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';
import {
    METADATA_KEY as WI_METADATA_KEY,
    getWorldInfoSettings,
    deleteWorldInfo,
    loadWorldInfo,
    saveWorldInfo,
    selected_world_info,
    updateWorldInfoList,
    updateWorldInfoSettings,
    world_names,
} from '../../../world-info.js';

// ============================================================================
// CONSTANTS
// ============================================================================
const EXT = 'ff4-vir-lorebook-sync';
const VERSION = '6.2.1';
const WORLD_PREFIX = 'FF4 VIR - ';
const CHAT_OVERRIDE_KEY = 'ff4VirOverrides';

// Tier system — re-applied every sync based on scene_state
// Tier A: pinned mains (always inject)
// Tier B: chars in scene_state.active_characters (constant=true)
// Tier C: chars in recall window (constant=true for N turns)
// Tier D: offscreen chars (constant=false, keyword-only — costs zero tokens until mentioned)
const TIER = {
    PINNED:    { order: 60, depth: 1 },
    ACTIVE:    { order: 70, depth: 2 },
    RECALL:    { order: 72, depth: 2 },
    OFFSCREEN: { order: 80, depth: 3 },
};

// Dialogue color palette — light/bright colors only (dark-theme readable)
// Stored inside each char's voice_lock.dialogue_color so AI sees it in VIR
// context and references it consistently.
const DIALOGUE_PALETTE = [
    '#FF8A80', // coral red
    '#FFAB91', // peach
    '#FFCC80', // light orange
    '#FFE082', // butter yellow
    '#FFF59D', // pale yellow
    '#A5D6A7', // mint green
    '#80CBC4', // soft teal
    '#80DEEA', // light cyan
    '#81D4FA', // sky blue
    '#90CAF9', // ice blue
    '#B39DDB', // soft lavender
    '#CE93D8', // light orchid
    '#F48FB1', // rose pink
    '#F8BBD0', // pale pink
    '#E1BEE7', // pale violet
    '#FFD180', // honey
];

// Regex patterns for packet detection
const SYNC_RE_FENCE = /```vir\b\s*\n?([\s\S]*?)\n?```/gi;
const SYNC_RE_XML = /<vir_sync\b[^>]*>([\s\S]*?)<\/vir_sync>/gi;
const TAIL_SCAN_CHARS = 5000;

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================
const defaultSettings = {
    enabled: true,
    debug: false,
    autoHideSyncedPackets: true,
    bindToChat: true,
    cleanupOnChatDelete: true,
    smartTiers: true,                // recommended: dynamic constant flag per scene
    contractInjection: false,        // DEPRECATED legacy path. The v6 design carries the
                                     // contract via the constant "FF4 VIR Rules" lorebook
                                     // entry. Leaving this on duplicates the full ~3k-token
                                     // contract (setExtensionPrompt copy + lorebook copy) at
                                     // the same depth every turn. Keep false.
    seedUserPersona: true,           // auto-seed a pinned VIR entry from the active persona
    recallTurnsDefault: 8,           // longer than v4 for better long-term memory
    templateMode: 'Detailed',
    diagnosticsEnabled: true,
    sheetCommandMode: 'Detailed',
    // lastInjectionPreview retired in v6 (state injection removed; debug
    // preview is built on demand from the live lorebook in the diagnostics
    // panel — see renderSettings).

    // v6.1 — Refresh button settings
    refreshContextTurns: 20,         // chat-tail size sent to AI during a refresh (5–50)
    refreshDebounceMs: 30000,        // per-character lockout after successful refresh
    worldChatMap: {},
    pinnedCharacters: {},
    recallCharacters: {},
    lastSyncStatus: 'No sync yet',
    lastSyncAt: 0,
    sessionPacketCount: 0,
    recentWarnings: [],
    // ── v5.4 miss tracking (escalating depth-1 reminder) ──
    consecutiveMisses: 0,            // streak of recent turns with no vir block
    totalMisses: 0,                  // lifetime counter across all chats (debug aid)
    // ── v5.5 dialogue colour application ──
    dialogueColorEnabled: false,     // colour the .name_text label per voice_lock.dialogue_color
};
const MAX_RECENT_WARNINGS = 10;
let processingQueue = Promise.resolve();
let sessionPacketCount = 0;

// v6 — three templates (Compact / Standard / Detailed). Mixing templates across
// characters confuses the AI; the chosen template applies to the whole chat.
// Per-character control is via the Refresh button (one-off re-emit of that char).
const VIR_TEMPLATE_MODES = {
    Compact: {
        label: 'Compact',
        budgetTokens: 128,
        summary: 'Lowest-token mode. Minimum fields for stable continuity.',
        rules: [
            'Use the minimum identity facts needed for visual stability: species, age, hair, eyes, skin tone, outfit summary, pose, expression.',
            'On create: emit only the most identity-load-bearing fields. Skip nested cosmetics (brow_lash, lips_teeth, body_material, hands_feet, marks beyond distinguishing).',
            'On update: emit only fields that visibly changed this turn.',
            'Compress with commas; one short sentence per character block when possible.',
            'Omit decorative or interpretive wording.',
        ],
    },
    Standard: {
        label: 'Standard',
        budgetTokens: 192,
        summary: 'Balanced default. Full identity anchors, compact phrasing.',
        rules: [
            'On create: emit all stable identity anchors plus current visual state. Skip rarely-imaged cosmetic fields (brow_lash, lips_teeth, body_material).',
            'Compress identity with commas (Identity: ...); list outfit pieces but not material/closure details unless distinguishing.',
            'On update: focus on outfit, pose, expression, condition, exposure, location_context. Do not re-emit stable identity unless repairing a weak field.',
            'Keep values concrete and image-friendly.',
        ],
    },
    Detailed: {
        label: 'Detailed',
        budgetTokens: 256,
        summary: 'Maximum detail mode. All fields. Strongest visual anchors.',
        rules: [
            'On create or repair: emit every visible identity field with enough specificity for consistent image prompting.',
            'Include body_material, brow_lash, lips_teeth, hands_feet, and full non_human details when present.',
            'Outfit pieces include material, color, fit, and closure when known.',
            'Preserve stable identity exactly after creation unless the story explicitly changes it.',
            'On update: focus on changed outfit, pose, expression, condition, exposure, accessories, equipment, and location_context.',
        ],
    },
};

// v6 — backwards-compat: legacy template names auto-resolve to closest match
const TEMPLATE_ALIASES = {
    'VN Director': 'Standard',
    'Image Heavy': 'Detailed',
};
function resolveTemplateMode(mode) {
    const name = typeof mode === 'string' ? mode : (mode?.label || 'Detailed');
    const resolved = TEMPLATE_ALIASES[name] || name;
    return VIR_TEMPLATE_MODES[resolved] || VIR_TEMPLATE_MODES.Detailed;
}

function buildTemplateModeBlock(mode) {
    const m = resolveTemplateMode(mode);
    const rules = Array.isArray(m?.rules) ? m.rules : [];
    return [
        `[VIR TEMPLATE MODE: ${m.label}]`,
        m.summary || '',
        '',
        '[MODE RULES]',
        ...rules.map(rule => `- ${rule}`),
        '[/MODE RULES]',
        '[/VIR TEMPLATE MODE]',
    ].filter(Boolean).join('\n');
}

// v6 — single 256-token cap matching the Detailed renderer's ceiling.
// The renderer may downgrade to 192 (Standard) or 128 (Compact) per the
// user's chosen template, but the AI never has reason to emit more than 256
// — anything past that gets dropped during render. Old 512/380 numbers are
// gone from the contract.
function buildVirBudgetBlock() {
    return [
        '[VIR OUTPUT BUDGET]',
        'Keep each character create/update block ≤ 256 tokens (~190 words). Hard cap.',
        'Stable identity anchors first, then current visual state.',
        'Cut decoration, repetition, and restated unchanged identity before cutting anchors.',
        'On update: emit only changed fields. Do not restate stable identity unless repairing a weak or missing field.',
        '[/VIR OUTPUT BUDGET]',
    ].join('\n');
}

// ============================================================================
// THE VIR CONTRACT — auto-injected as system prompt every generation
// ============================================================================
// VIR contract — the format directive + per-field detail guidance. Injected
// every generation at IN_CHAT depth 4. Detail level is deliberate: the VIR
// is the source of truth every <pic> tag copies from, so vague fields = a
// character that looks different in every image. The contract teaches the
// model what detail each field needs and why. Preset-level rules (color
// palette, output order, FORBIDDEN/CORRECT) still live in the user's preset.
const VIR_CONTRACT = `[VIR TRACKING CONTRACT — visual identity registry]

End EVERY reply with exactly one \`\`\`vir code-fence block in the visible message — placed AFTER prose, AFTER all <pic> tags, AFTER the STATS UPDATE section. If another tracker code-fence is also required (e.g. \`\`\`rpg from an RPG STATE TRACKER), that other tracker takes the FINAL slot and \`\`\`vir comes immediately before it. VIR's parser does not care about absolute final position — it only needs to find \`\`\`vir somewhere in the visible reply. One line of flat JSON, schema 3:
{"schema":3,"characters":[{"name":"...","action":"create|update",<flat fields>}],"scene":{"location":"...","time":"...","active":"Name1,Name2"},"states":[{"name":"...","position":"...","aftermath":0}],"recall":[]}
Flat name-keyed objects only — never nest objects under a name, never nest voice_lock. Multi-piece fields (outfit, accessories, equipment, underwear) are SEMICOLON-separated strings.

WHY DETAIL MATTERS: the VIR is the single source of truth that every <pic> tag copies from. If a field is vague, the image generator invents something different each pic and the character looks inconsistent across images. Every field must be specific enough that two different pics, generated hours apart, render the SAME character.

PER-CHARACTER FIELDS:

STABLE FIELDS (emit fully on first 'create'; only change when the STORY explicitly causes it — same causality rule as stat deltas: no story event = no change):
- full_name: full canon/display name if known. Use the show/card/original character name, not a short nickname.
- species: e.g. "adult human female", "anthro arctic fox male", "slime girl", "dryad"
- source: full canon franchise/show/game/VN/source name, or exactly "original character" if the character has no source. Do not invent a source.
- age_appearance, height, build: "looks mid-20s", "168 cm", "slim hourglass, soft tummy"
- body_material: WHAT THE BODY IS MADE OF. MANDATORY for any non-human species — this is the #1 cause of wrong renders. A slime girl is NOT a human with coloured skin; a dryad is NOT a human with green skin. State the substance + texture + how it behaves:
    slime girl  → "entire body is translucent blue-green gel, soft and jiggly, no skeleton, deformable, light refracts through her, surface glistens wet"
    dryad       → "body is living wood and bark, smooth pale birch torso, mossy patches at the joints, hair is a cascade of real leaves and small vines, fingers end in twig-like tips"
    ghost       → "semi-transparent pale vapour, lower body fades to mist, no solid mass, faint inner glow"
    For an ordinary human, leave body_material empty.
Use plain simple words for all fields — the kind a child knows. No fancy or rare words.
DETAIL FLOOR — EVERY anchor below must be filled per character. Vague values cause "looks different in every pic". Aim for 6-10 concrete attributes per visual field, not 2-3. Specific words beat generic ones (chocolate-brown > brown, mid-calf > tall, twelve-eyelet lace-up > laced).

- hair: shade + length to a body landmark + texture + styling + parting + fringe/bang + distinguishing detail.
    DETAIL FLOOR: "honey-blonde with lighter sun-bleached tips, falls to mid-back when down, straight with a slight wave at the ends, parted on the right, side-swept fringe brushing the brow, one thin braid behind the left ear"
    TOO THIN (do not write this): "long blonde, straight, with a fringe"
- eyes: specific shade + secondary tone + shape + size + lash detail + distinguishing detail.
    DETAIL FLOOR: "warm forest-green with a darker emerald ring around the iris, almond-shaped, slightly upturned at the outer corner, average size, long thick natural lashes, faint laugh lines at the outer corner"
    TOO THIN: "green, round"
- skin: specific tone + undertone + texture + distinguishing skin features.
    DETAIL FLOOR: "warm light-olive skin with peach undertone, smooth except for a small constellation of light freckles across the bridge of the nose and onto both cheekbones, faint tan line at the upper arms"
    For fur/scales: "soft burnt-orange fur over the back and head fading to cream on the chest and belly, sleek short fur with longer ruff at the neck, three thin darker brown stripes on the upper arms"
    TOO THIN: "tan skin" / "orange fur"
- face_features: nose + cheeks + lips + jaw + chin + ears (if not non_human) + brow + distinguishing micro-features.
    DETAIL FLOOR: "small straight nose with a slight upturn at the tip, soft full cheeks, naturally rosy heart-shaped lips with a defined cupid's bow, narrow rounded jaw, small pointed chin, small attached earlobes, slim natural brow with a small mole at the outer end of the left one"
    TOO THIN: "small nose, round cheeks, thin lips"
- body: shoulders + chest + waist + hips + arms + legs + posture-relevant details.
    DETAIL FLOOR: "narrow sloping shoulders, full C-cup breasts with a small natural sag, defined narrow waist (hourglass ratio), wide rounded hips, slender arms with soft definition, long shapely legs with toned thighs and slim calves"
    TOO THIN: "medium breasts, narrow waist, wide hips"
- marks: type + size + exact shape + EXACT placement (which side, where relative to anatomical landmarks) + colour + age/healing.
    DETAIL FLOOR: "thin pale-pink one-inch crescent scar two cm above the outer end of the left eyebrow, faded and slightly raised; small dark-brown round mole on the right cheek halfway between the corner of the mouth and the ear; black-ink five-pointed star tattoo on the inside of the left wrist, two cm wide, fully healed and saturated"
    TOO THIN: "scar above eyebrow"
- non_human: type + size + colour + placement + distinguishing detail.
    DETAIL FLOOR: "long pointed cat ears set high on the head, soft inner fur a paler pink-cream, outer fur matching her hair colour, the left ear has a small notch on its outer edge; long fluffy fox tail starting at the base of the spine, the same orange as her hair fading to a white tip, held with a slight upward curve at the base"
    TOO THIN: "pointed cat ears, long fluffy tail"

FIELD PERSISTENCE — THE ANTI-DRIFT RULE:
Every field value, once written, persists unchanged until you emit an explicit update for it. If you did not write an update this turn, the field is identical to last turn — copy it forward unchanged. A field does not silently gain or lose content. Glasses that appeared last turn stay on. Glasses never mentioned stay off. A scar that was established stays. An accessory not in the VIR does not appear. The VIR is a record of what the story established, not a creative canvas.

CURRENT STATE (update the MOMENT it changes — this is what keeps pics consistent):

FIELD QUALITY RULE: write every field value in short, plain, simple words — the kind a child knows. The values feed a small image encoder that cannot handle rare or fancy words. Colour + basic material + item name + simple shape is enough. No literary words.

- hair_state: how the hair sits RIGHT NOW — "tied up in a high ponytail", "wet and flat against her shoulders", "loose and messy with strands in her face"
- outfit: EVERY worn piece, semicolon-separated, with the FULL anchor set per piece — colour shade + material + item type + cut/sleeve/neckline + fit + length + closure/fastening + distinguishing detail. The model paints what the words paint; if a piece has only 3 anchors, the model invents the other 5 differently every pic.
    DETAIL FLOOR (good): "chocolate-brown distressed buttery leather vest, fitted at the waist, asymmetric front zip with brass teeth running from right hip up to the left collarbone, two slim chest pockets, sleeveless with a narrow lapel; cream-white linen long-sleeve shirt under the vest, banded collar, sleeves rolled to mid-forearm showing the inner cuff; charcoal-grey wool trousers, slim straight leg, ankle-length with no cuff, sits at the natural waist, plain front no pleats; warm tan distressed leather boots, mid-calf height ending two finger-widths below the knee, twelve-eyelet front lace-up crossed in an X pattern with leather cord, low block heel, rounded toe, slight scuff on the right toe cap"
    TOO THIN (do NOT write): "brown leather vest; white shirt; dark grey pants; tall brown boots" — every word here is a hole the model fills differently each render.
    BAD (NEVER): "practical adventurer clothes" / "casual outfit" / "leather top and pants" / "boots" — these are not pieces, they are labels.
    For footwear specifically, ALWAYS include: height (ankle / mid-calf / knee-high / over-the-knee / thigh-high) + closure (lace-up with N eyelets / side-zip / slip-on / buckle) + heel (flat / low block / mid stiletto / chunky platform) + toe (round / pointed / square / open).
- underwear: same detail floor as outfit. "matte black satin bra with thin spaghetti straps, half-cup balconette shape, thin lace trim along the upper edge, small bow at the centre; matching matte black satin high-cut briefs, mid-rise, thin bow at each hip"
    TOO THIN: "black bra; black underwear"
- accessories: type + material + colour + placement (which finger/ear/wrist/neck) + size + distinguishing detail. Per-item, semicolon-separated.
    DETAIL FLOOR: "small polished silver hoop earrings, eight mm diameter, one in the lower lobe of each ear; thin antique-brass twisted-rope belt around the natural waist, oval buckle stamped with a leaf motif, belt holes punched at regular intervals; plain matte gold band ring on the right ring finger, three mm wide"
    TOO THIN: "silver earrings; leather belt; ring"
    If none worn: omit the field entirely. NEVER invent.
- equipment / holding: same — "weathered short sword in a worn dark-brown leather scabbard belted at the left hip, brass pommel shaped like an oak leaf"; "white ceramic mug filled with dark coffee, gripped in the right hand by the handle"
- pose: plain posture in a few short words — "standing at the counter, right hand flat on the top, looking left"
- expression: face in simple words — "small smile, eyes a little narrow, head tilted right"
- condition: every visible mark right now — "sweat on forehead; lipstick smeared on lower lip; small bruise on left cheek; mud on right boot"
- location_context: where they stand or sit — "sitting on the left side of a wood booth, facing the door"

TRACK {{user}} TOO — THE PLAYER CHARACTER:
Standard RP convention has you describe only NPCs and skip {{user}}. This contract OVERRIDES that. {{user}} also needs a VIR entry so they render consistently in <pic> tags.
- Include {{user}} in the characters array, using their actual name (not the literal text "{{user}}").
- First appearance: emit action:"create" for {{user}} with every identity field you can establish.
- DRAFT {{user}}'s appearance from CURRENT CONTEXT ONLY. Priority: (1) active persona description if it has visual detail; (2) current card, scenario, first message, and visible story/chat evidence; (3) reasonable neutral defaults that fit the current setting and genre. Do NOT use other saved personas, unrelated chats, memory from other sessions, or old profiles.
- NEVER leave {{user}}'s immutable fields (species, age_appearance, build, hair, eyes, skin) blank. If the story genuinely never says, pick something plausible for the setting and KEEP IT FIXED — once created, {{user}}'s immutable fields never change, exactly like an NPC.
- After 'create', emit 'update' for {{user}} only when something visibly changes (outfit, pose, condition) — same rule as everyone else.

ACTIONS: 'create' = first appearance, emit ALL known fields. 'update' = emit ONLY the fields that changed this turn. If a character undresses, emit an update with the new outfit/underwear/condition. If nothing visual changed for a character, omit them from the packet entirely. EXCEPTION: {{user}} must get a 'create' as soon as the story gives any basis for their look — do not wait or skip them.

[WORLD SIMULATION]
You are the game master of a living world. Every turn, BEFORE writing the reply, advance ALL tracked characters simultaneously — not just those in the current scene.

For each off-screen character, ask: what has this person been doing since the last scene? What happened to them? The world did not pause while the camera was elsewhere. They lived, acted, suffered, healed, chose, and changed. Simulate it honestly — anything can happen. A character can get stronger, weaker, poisoned, cured, heartbroken, drunk, arrested, robbed, or killed. They can change clothes, lose equipment, gain allies, fall in love, or quietly give up. There are no forbidden outcomes. Let the world be real.

Base the simulation on: their last known state and VIR entry, their location, goals, personality, any active conditions, and the in-world time elapsed. A warrior alone in camp probably trains. A poisoned rogue without a healer gets worse. A grieving character might not eat. A resourceful one finds a way. A person with enemies isn’t safe just because the camera looked away. Follow the logic of who they are and what the world would plausibly do to them.

Whatever happened to an off-screen character this turn — stat changes, outfit changes, injuries, recoveries, emotional shifts, equipment lost or gained, death — goes into STATS UPDATE and into their VIR ‘update’ entry, exactly like an on-screen character. A character does not need to appear in the prose to receive updates. Their story runs in parallel.

[STATS TRACKER]
Stats are the numeric layer of the world simulation. The exact stat list per character lives in their card / persona; system rules in “SYSTEM: Stats”; event triggers in “SYSTEM: Stat Events”. Never invent stats outside those entries.

VISIBLE OUTPUT (mandatory every reply):
End the visible reply (after prose, after all <pic> tags, BEFORE the \`\`\`vir block) with this exact section:

  ─── STATS UPDATE ───
  **CharacterName**
    • StatName oldValue → newValue — one-line reason
  **OtherCharacter**
    • StatName old → new — reason

Use each character’s actual name. Use {{user}}’s actual name, not the literal “{{user}}”.

IF NOTHING CHANGED FOR ANYONE, still emit:
  ─── STATS UPDATE ───
  *No stats changed this turn.*
NEVER silently skip it. A reply without STATS UPDATE is malformed.

THE REASON IS MANDATORY:
Every bullet needs “— reason” — a concrete thing that happened (“took the blast for her”, “ran twelve hours through the storm”, “three days without food”). No filler. No cause → no delta.

[STATS → VISUAL LINK]
Stats are not just numbers — they shape how a character LOOKS right now. Any stat delta you emit in the STATS UPDATE block MUST also produce a matching update inside this turn’s \`\`\`vir block, on that character’s entry. Land the effect in the existing transient-state fields: condition, pose, expression. Immutable identity fields (build, body, hair, eyes, marks, body_material) stay locked per the rules above — never modify them for a stat change. Stat changes affect APPEARANCE OF state, not anatomy.

This is what makes <pic> tags actually reflect the state. Without this link a Stamina drop is just a number — the rendered image stays fresh.

MAPPING BASELINE (extend in "SYSTEM: Stats" → visual_effect field per stat):

  STRENGTH ↓   pose: "shoulders slumped, arms hanging loose"
               condition: "muscles trembling under exertion"
  STRENGTH ↑   pose: "shoulders squared, chest open, weight forward"

  STAMINA ↓    condition: "breathing heavy, sweat on brow, face pale"
               pose: "leaning on the wall for support"
  STAMINA ↑    condition: "steady breathing, clear-eyed"

  HEALTH ↓     condition: actual injury from the event — "bruise forming on left cheek, blood on knuckles, limping"
               pose: "favouring the injured side, hand pressed to ribs"

  COMPOSURE ↓  expression: "jaw tight, eyes wet, hands shaking"
  COMPOSURE ↑  expression: "calm half-smile, level gaze"

  TRUST(X) ↑   pose: "body angled toward X, soft eye contact"
  TRUST(X) ↓   pose: "stiff posture toward X, gaze averted"

  AROUSAL ↑    condition: "flushed cheeks, dilated pupils, sheen of sweat"
  AROUSAL ↓    condition: "(clear — no arousal flush)"

For stats not in this list, read the visual_effect field from the "SYSTEM: Stats" lorebook. If a stat has none, choose a posture or condition a viewer would read as "more / less of that stat".

Multi-piece field syntax matches everywhere else in this contract — semicolon-separated:
  condition: "breathing heavy; bruise forming on left cheek; sweat on brow"

RECOVERY:
When a stat moves back toward baseline (rest, healing, comfort), CLEAR the matching descriptors from condition/pose — don’t just stop adding new ones, or the character stays visually exhausted forever.

[FINAL CHECK — DO THIS RIGHT BEFORE SENDING]
1. Does your reply contain a \`\`\`vir code-fence in the VISIBLE message (not in reasoning, not in <details>), placed AFTER prose, AFTER pic tags, AFTER STATS UPDATE? \`\`\`vir does NOT have to be the absolute last block if another tracker (e.g. \`\`\`rpg) also requires the last slot — in that case let the other tracker close the message and put \`\`\`vir just before it. (Yes/no)
2. Does it ALSO contain a "─── STATS UPDATE ───" section, placed just before that \`\`\`vir block? (Yes/no)
3. If any stat moved this turn, does every bullet have a one-line reason citing a concrete event from THIS turn?
4. If any stat moved, did the SAME deltas also produce a condition / pose / expression update inside the \`\`\`vir block for that character?
5. If no stats moved, did you still emit the STATS UPDATE section with "*No stats changed this turn.*"?
A "no" to any of these means the reply is malformed — fix before sending.
A stats or vir block that exists only in your reasoning / thinking does NOT count. It must appear in the final visible message.`;

// ============================================================================
// SETTINGS / LOGGING
// ============================================================================
function settings() {
    extension_settings[EXT] = Object.assign({}, defaultSettings, extension_settings[EXT] || {});
    return extension_settings[EXT];
}
function log(...args)   { if (settings().debug) console.log(`[${EXT}]`, ...args); }
function warn(...args)  { console.warn(`[${EXT}]`, ...args); }
function error(...args) { console.error(`[${EXT}]`, ...args); }

function getChatOverrides() {
    const raw = chat_metadata?.[CHAT_OVERRIDE_KEY];
    const template = resolveTemplateMode(raw?.templateMode).label;
    const hasTemplateOverride = typeof raw?.templateMode === 'string' && !!String(raw.templateMode).trim();
    return {
        disabled: raw?.disabled === true,
        templateMode: hasTemplateOverride ? template : '',
        mergeIntoChatLore: raw?.mergeIntoChatLore === true,
    };
}

function getEffectiveTemplate() {
    return getChatOverrides().templateMode || settings().templateMode || 'Detailed';
}

function isVirDisabledForChat() {
    return settings().enabled !== true ? true : getChatOverrides().disabled === true;
}

async function setChatOverrides(nextOverrides) {
    if (typeof chat_metadata !== 'object' || !chat_metadata) return false;
    const normalized = {
        disabled: nextOverrides?.disabled === true,
        templateMode: nextOverrides?.templateMode ? resolveTemplateMode(nextOverrides.templateMode).label : '',
        mergeIntoChatLore: nextOverrides?.mergeIntoChatLore === true,
    };
    if (!normalized.disabled && !normalized.templateMode && !normalized.mergeIntoChatLore) {
        delete chat_metadata[CHAT_OVERRIDE_KEY];
    } else {
        chat_metadata[CHAT_OVERRIDE_KEY] = normalized;
    }
    try {
        await saveMetadata();
    } catch (e) {
        warn('saveMetadata failed', e);
    }
    return true;
}

// v6 P2-9 — single canonical surface for pinnedCharacters[worldName].
// Internally treated as a Set (dedup, O(1) membership); persisted as an
// array (JSON-stable). All add/remove paths must go through these helpers
// so we can't accidentally mix array and Set semantics across call sites.
function getPinnedSet(worldName) {
    const st = settings();
    const raw = st.pinnedCharacters?.[worldName];
    return new Set(Array.isArray(raw) ? raw : (raw ? Object.keys(raw) : []));
}
function persistPinnedSet(worldName, set) {
    const st = settings();
    st.pinnedCharacters = st.pinnedCharacters || {};
    st.pinnedCharacters[worldName] = [...set]; // marshalled to array for JSON
    saveSettingsDebounced();
}
function pinCharacter(worldName, name) {
    const set = getPinnedSet(worldName);
    if (set.has(name)) return false;
    set.add(name);
    persistPinnedSet(worldName, set);
    return true;
}
function unpinCharacter(worldName, name) {
    const set = getPinnedSet(worldName);
    if (!set.has(name)) return false;
    set.delete(name);
    persistPinnedSet(worldName, set);
    return true;
}
function toastInfo(msg) { if (settings().debug) toastr.info(msg, 'FF4 VIR Sync'); }

function uniqueClean(values) {
    return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
}

function noteSyncStatus(message, warnings = [], isError = false) {
    const st = settings();
    st.lastSyncStatus = message;
    st.lastSyncAt = Date.now();
    if (warnings.length) {
        st.recentWarnings = [...uniqueClean(warnings), ...(st.recentWarnings || [])].slice(0, MAX_RECENT_WARNINGS);
    }
    if (isError) st.recentWarnings.unshift(`ERROR: ${message}`);
    saveSettingsDebounced();
    updateStatus();
}

// ============================================================================
// WORLD RESOLUTION
// ============================================================================
function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
}
function safeNamePart(value) {
    return String(value || 'chat').replace(/\.[^/.]+$/, '').replace(/[<>:"/\\|?* -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 90) || 'chat';
}
function isVirWorldName(name) {
    return String(name || '').startsWith(WORLD_PREFIX);
}
function isUsingMergedChatLore() {
    const bound = chat_metadata?.[WI_METADATA_KEY];
    return settings().bindToChat === true
        && getChatOverrides().mergeIntoChatLore === true
        && !!bound
        && !isVirWorldName(bound)
        && (world_names || []).includes(bound);
}
function currentWorldName() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const stableId = chat_metadata?.integrity || chatId;
    const suffix = hashString(stableId);
    const bound = chat_metadata?.[WI_METADATA_KEY];
    if (isUsingMergedChatLore()) return bound;
    if (bound && isVirWorldName(bound) && (world_names || []).includes(bound)) return bound;
    const existing = (world_names || []).find(n => String(n).startsWith(WORLD_PREFIX) && String(n).endsWith(`-${suffix}`));
    if (existing) return existing;
    const mapped = settings().worldChatMap || {};
    const fromMap = Object.entries(mapped).find(([w, info]) => info?.chatId === String(chatId) && (world_names || []).includes(w));
    if (fromMap) return fromMap[0];
    return `${WORLD_PREFIX}${safeNamePart(chatId)}-${suffix}`;
}
function rememberWorldChat(worldName, chatId = getCurrentChatId()) {
    if (!worldName || !chatId || !isVirWorldName(worldName)) return;
    const st = settings();
    st.worldChatMap = st.worldChatMap || {};
    st.worldChatMap[worldName] = { chatId: String(chatId), integrity: chat_metadata?.integrity || null, updatedAt: Date.now() };
    saveSettingsDebounced();
}

function syncChatLorebookUi(boundWorldName = chat_metadata?.[WI_METADATA_KEY] || '') {
    const worldName = String(boundWorldName || '');
    const hasWorld = worldName && Array.isArray(world_names) && world_names.includes(worldName);
    document.querySelectorAll('.chat_lorebook_button').forEach(el => {
        el.classList.toggle('world_set', !!hasWorld);
    });
}

function notifyLoreOperation(message, title = 'FF4 VIR') {
    if (typeof toastr !== 'undefined' && message) {
        toastr.info(message, title, { timeOut: 3500 });
    }
}

function isManagedVirEntry(entry) {
    if (!entry) return false;
    if (entry.comment === RULES_ENTRY_COMMENT || entry.comment === RECOVERY_ENTRY_COMMENT ||
        entry.comment === 'FF4 FF4_STATE' || entry.comment === 'FF4 VIR Roster') return true;
    return /^VIR:\s*/i.test(String(entry.comment || '')) && /\[ACTIVE VIR:/i.test(String(entry.content || ''));
}

async function clearVirEntriesFromWorld(worldName) {
    const data = await loadWorldInfo(worldName);
    if (!data) return 0;
    const entries = getEntries(data);
    let removed = 0;
    for (const [uid, entry] of Object.entries(entries)) {
        if (!isManagedVirEntry(entry)) continue;
        delete entries[uid];
        removed++;
    }
    if (removed > 0) {
        await saveWorldInfo(worldName, data, true);
        await updateWorldInfoList();
    }
    delete settings().pinnedCharacters?.[worldName];
    delete settings().recallCharacters?.[worldName];
    saveSettingsDebounced();
    return removed;
}

async function resolveChatLoreConflict(boundWorldName) {
    const choice = await Popup.show.confirm(
        'FF4 VIR chat lore conflict',
        `This chat already uses the chat lorebook <b>${escapeHtml(boundWorldName)}</b>.<br><br>` +
        `FF4 VIR cannot take the same chat-lore slot without a decision.<br><br>` +
        `Choose one:<br>` +
        `1. Switch FF4 VIR to global mode.<br>` +
        `2. Merge FF4 VIR entries into the existing chat lorebook.`,
        {
            okButton: false,
            cancelButton: 'Cancel',
            customButtons: [
                { text: 'Switch to global mode', result: POPUP_RESULT.CUSTOM1, classes: ['menu_button'] },
                { text: 'Merge into existing chat lore', result: POPUP_RESULT.CUSTOM2, classes: ['menu_button'] },
            ],
        },
    );
    if (choice === POPUP_RESULT.CUSTOM1) {
        settings().bindToChat = false;
        saveSettingsDebounced();
        await setChatOverrides({ ...getChatOverrides(), mergeIntoChatLore: false });
        notifyLoreOperation(`FF4 VIR switched to global mode because this chat already uses "${boundWorldName}" as chat lore.`);
        return 'global';
    }
    if (choice === POPUP_RESULT.CUSTOM2) {
        await setChatOverrides({ ...getChatOverrides(), mergeIntoChatLore: true });
        notifyLoreOperation(`FF4 VIR will merge into the existing chat lorebook "${boundWorldName}" for this chat.`);
        return 'merge';
    }
    notifyLoreOperation(`FF4 VIR did not attach because this chat already uses "${boundWorldName}" as chat lore.`);
    return 'cancel';
}

// ============================================================================
// LOREBOOK HELPERS
// ============================================================================
function getEntries(data) {
    if (!data) return {};
    if (data.entries && typeof data.entries === 'object') return data.entries;
    return data.entries = {};
}
function nextUid(data) {
    const entries = getEntries(data);
    const ids = Object.keys(entries).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
    return ids.length ? Math.max(...ids) + 1 : 0;
}
function makeEntry({ uid, key, comment, content, constant = false, disable = false, order = 100, depth = 4, position = 4, excludeRecursion = false, preventRecursion = false }) {
    return {
        uid, key: Array.isArray(key) ? key : [key],
        keysecondary: [], comment: String(comment || ''),
        content: String(content || ''), constant, disable,
        order, depth, position, probability: 100, useProbability: true,
        addMemo: true, selective: true, group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: null, sticky: null, cooldown: null, delay: null,
        excludeRecursion, preventRecursion,
    };
}

function enforceVirRecursionFlags(entry) {
    if (!entry) return entry;
    entry.excludeRecursion = true;
    entry.preventRecursion = true;
    entry.scanDepth = 3;
    return entry;
}

function isUserVirEntry(entry) {
    if (!entry || !Array.isArray(entry.key)) return false;
    return entry.key.includes('{{user}}');
}

// ============================================================================
// VIR CONTENT GENERATION
// ============================================================================
function textValue(value) {
    if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('; ');
    if (value && typeof value === 'object') return Object.entries(value).filter(([, v]) => v).map(([k, v]) => `${k}: ${textValue(v)}`).join('; ');
    return String(value || '').trim();
}
function compactValue(value) {
    const text = textValue(value);
    return text || '';
}
function compactPiece(piece) {
    if (typeof piece === 'string') return piece.trim();
    if (!piece || typeof piece !== 'object') return '';
    const slot = piece.slot ? `[${piece.slot}] ` : '';
    const main = [
        piece.color_shade || piece.color,
        piece.material,
        piece.item_type || piece.type || piece.item,
        piece.cut_or_style || piece.cut || piece.style,
        piece.fit, piece.distinguishing_detail || piece.detail, piece.condition,
    ].filter(Boolean).join(' ');
    return `${slot}${main}`.trim();
}
function compactList(label, items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.map((item, index) => `${label}${index + 1}: ${compactPiece(item) || compactValue(item)}`)
        .filter(line => !line.endsWith(': '));
}

function splitPackedFacts(value) {
    return String(value || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

function genderPronoun(vir) {
    const sp = String(vir.species || vir.species_class || '').toLowerCase();
    if (/\b(female|girl|woman|mare|hen|doe|vixen|she)\b/.test(sp)) return 'she';
    if (/\b(male|man|boy|stallion|cock|buck|he)\b/.test(sp)) return 'he';
    return 'they';
}

function canonicalCharacterName(name, vir = {}) {
    return compactValue(vir.full_name || vir.canon_name || vir.display_name || vir.original_name || name);
}

function canonicalSourceName(vir = {}) {
    return compactValue(vir.source || vir.franchise || vir.series || vir.show || vir.game || vir.vn || vir.origin);
}

function isOriginalSource(src) {
    return /^(original character|original|oc|own character|custom character|user original)$/i.test(String(src || '').trim());
}

function buildPicIdentity(name, vir = {}) {
    const fullName = canonicalCharacterName(name, vir);
    const source = canonicalSourceName(vir);
    if (!fullName && !source) return '';
    if (!source) return fullName;
    if (isOriginalSource(source)) return `${fullName}, an original character`;
    return `${fullName} from ${source}`;
}

function buildPicParagraph(name, vir) {
    const p = genderPronoun(vir);
    const P = p === 'they' ? 'They' : p === 'she' ? 'She' : 'He';
    const possessive = p === 'they' ? 'Their' : p === 'she' ? 'Her' : 'His';
    const skin = vir.skin_fur_scales || vir.skin || vir.fur || vir.scales;
    const anatomy = vir.anatomy || vir.genitals || vir.nsfw_anatomy;
    const condition = compactValue([
        vir.condition,
        vir.aftermath_marks || (Number(vir.aftermath) > 0 ? `aftermath active (${vir.aftermath} turns)` : ''),
        vir.body_fluids, vir.injuries, vir.dishevelment,
    ]);
    const hairNow = compactValue(vir.hair_state || vir.hair_now || vir.hairstyle_now);
    const outfitParts = Array.isArray(vir.outfit || vir.outfit_layers)
        ? (vir.outfit || vir.outfit_layers).map(x => compactPiece(x) || compactValue(x)).filter(Boolean)
        : [compactValue(vir.outfit || vir.outfit_layers)].filter(Boolean);
    const underwearParts = Array.isArray(vir.underwear)
        ? vir.underwear.map(x => compactPiece(x) || compactValue(x)).filter(Boolean)
        : [compactValue(vir.underwear)].filter(Boolean);
    const accParts = Array.isArray(vir.accessories)
        ? vir.accessories.map(x => compactPiece(x) || compactValue(x)).filter(Boolean)
        : [compactValue(vir.accessories)].filter(Boolean);
    const eqParts = Array.isArray(vir.equipment)
        ? vir.equipment.map(x => compactPiece(x) || compactValue(x)).filter(Boolean)
        : [compactValue(vir.equipment)].filter(Boolean);

    const s = [];
    const add = (txt) => { if (txt) s.push(txt.trim().replace(/\.+$/, '') + '.'); };
    const an = (word) => /^[aeiou]/i.test(word) ? 'an' : 'a';

    // Identity
    const picIdentity = buildPicIdentity(name, vir);
    if (picIdentity) add(picIdentity);
    const sp = compactValue(vir.species || vir.species_class);
    if (sp) {
        const bits = splitPackedFacts(sp);
        if (bits.length > 1) {
            add(`${P} is ${an(bits[0])} ${bits[0]}`);
            for (const bit of bits.slice(1)) add(`${P} is ${bit}`);
        } else {
            add(`${P} is ${an(sp)} ${sp}`);
        }
    }
    if (vir.age_appearance) add(String(vir.age_appearance).trim().toLowerCase().startsWith('looks ') ? `${P} ${vir.age_appearance}` : `${P} looks ${vir.age_appearance}`);
    if (vir.height) add(`${P} is ${vir.height} tall`);
    // build separate from body to avoid double-printing
    if (vir.build) add(`${P} has a ${compactValue(vir.build)} build`);
    const bodyDetail = compactValue([vir.body, anatomy]);
    if (bodyDetail) add(`${P} has ${bodyDetail}`);
    // Non-human body material — must come before skin. NL form, no label.
    const mat = compactValue(vir.body_material || vir.composition || vir.material);
    if (mat) add(`${possessive} body is ${mat}`);
    // Hair
    if (vir.hair) {
        const hs = hairNow && hairNow !== 'neat, default' && hairNow !== compactValue(vir.hair)
            ? `${compactValue(vir.hair)}, currently ${hairNow}` : compactValue(vir.hair);
        add(`${P} has ${hs}`);
    }
    if (vir.eyes) add(`${P} has ${compactValue(vir.eyes)} eyes`);
    if (skin) add(`${P} has ${compactValue(skin)}`);

    // NL conversion: no more "Face:", "Marks:", "Pose:" labels — Qwen 0.6B reads labels literally.
    // Empty-equivalents ("none", "n/a") are SKIPPED so the encoder never paints "none" as content.
    const NIL_RE = /^\s*(none|n\/?a|nothing|nil|nada|empty|—|-)\s*$/i;
    const isNil = (v) => !v || NIL_RE.test(String(v).trim());
    const addIfReal = (v, fmt) => { if (!isNil(v)) add(fmt(String(v).trim().replace(/\.+$/, ''))); };

    const ff = compactValue(vir.face_features || vir.face);
    addIfReal(ff, v => `${P} has ${v}`);
    const bl = compactValue(vir.brow_lash || vir.brows_lashes);
    addIfReal(bl, v => `${P} has ${v}`);
    const lt = compactValue(vir.lips_teeth || vir.lips);
    addIfReal(lt, v => `${P} has ${v}`);
    const hf = compactValue(vir.hands_feet || vir.hands);
    addIfReal(hf, v => `${P} has ${v}`);
    const nh = compactValue(vir.non_human || vir.limb_config);
    addIfReal(nh, v => `${P} has ${v}`);
    const mk = compactValue(vir.marks);
    addIfReal(mk, v => `${P} has ${v}`);

    // Outfit / underwear / accessories / equipment: join pieces with semicolons for boundary
    // preservation while keeping the whole sentence flowing (no "Label:" prefix).
    // Special case: "naked"/"nude" as a piece → render as "is naked" not "wears naked".
    const nakedTokens = /^\s*(naked|nude|fully nude|completely nude)\s*$/i;
    const realOutfit = outfitParts.filter(p => !isNil(p) && !nakedTokens.test(p));
    const isNaked = outfitParts.some(p => nakedTokens.test(p));
    if (isNaked && !realOutfit.length) add(`${P} is naked`);
    else if (isNaked && realOutfit.length) add(`${P} is mostly naked, with ${realOutfit.join('; ')} still on or nearby`);
    else if (realOutfit.length) add(`${P} wears ${realOutfit.join('; ')}`);

    const realUnderwear = underwearParts.filter(p => !isNil(p));
    if (realUnderwear.length) add(`${P} wears ${realUnderwear.join('; ')} as underwear`);

    const realAcc = accParts.filter(p => !isNil(p));
    if (realAcc.length) add(`${P} wears ${realAcc.join('; ')}`);

    const realEq = eqParts.filter(p => !isNil(p));
    if (realEq.length) add(`${P} carries ${realEq.join('; ')}`);

    const holding = compactValue(vir.holding || vir.held_items || vir.in_hands);
    addIfReal(holding, v => `${P} holds ${v}`);

    // Pose: detect verb-starts ("sitting") → "She is sitting"; otherwise raw → "She <pose>".
    const pose = compactValue(vir.pose || vir.posture || vir.posture_voice);
    if (!isNil(pose)) {
        const poseLower = pose.trim().toLowerCase();
        const verbStart = /^(sitting|standing|kneeling|lying|leaning|walking|running|crouching|squatting|crawling|straddling|riding|bent|bending|laid|laying|seated|perched|on her|on his|on their|hands? |arms? |knees?\b|legs?\b)/;
        add(verbStart.test(poseLower) ? `${P} is ${pose}` : `${P} ${pose}`);
    }

    // Expression: detect verb-starts ("smiling") → "She is smiling"; otherwise → "She has <expr>".
    const expr = compactValue(vir.expression || vir.default_expression);
    if (!isNil(expr)) {
        const exprLower = expr.trim().toLowerCase();
        const verbStart = /^(smiling|frowning|grinning|crying|laughing|smirking|pouting|scowling|glaring|staring|blushing|gasping|moaning|biting|licking)/;
        if (verbStart.test(exprLower)) add(`${P} is ${expr}`);
        else if (exprLower.startsWith('mouth ') || exprLower.startsWith('eyes ') || exprLower.startsWith('lips ') || exprLower.startsWith('brow')) add(`${possessive} ${expr}`);
        else add(`${P} has ${expr}`);
    }

    // Condition: skip "normal" / "fine" / "okay" — those have nothing visual to render.
    const NEUTRAL_COND = /^\s*(normal|fine|okay|ok|good|nothing visible|clear)\s*\.?$/i;
    if (condition && !NEUTRAL_COND.test(condition.trim())) add(`${P} has ${condition}`);

    return s.join(' ');
}

// v6 — token estimation (approximate but deterministic).
// English+JSON ≈ 4 chars/token. Used by enforceBudget() during render.
function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

// Pull commonly-aliased fields once; renderers all share the same vir-shape.
function virExtract(vir = {}) {
    return {
        species: vir.species || vir.species_class,
        source: canonicalSourceName(vir),
        age: vir.age_appearance,
        height: vir.height,
        build: vir.build,
        body_material: vir.body_material || vir.composition || vir.material,
        hair: vir.hair,
        hair_state: vir.hair_state || vir.hair_now || vir.hairstyle_now,
        eyes: vir.eyes,
        face: vir.face_features || vir.face,
        brow_lash: vir.brow_lash || vir.brows_lashes,
        lips_teeth: vir.lips_teeth || vir.lips,
        skin: vir.skin_fur_scales || vir.skin || vir.fur || vir.scales,
        body: vir.body,
        anatomy: vir.anatomy || vir.genitals || vir.nsfw_anatomy,
        hands_feet: vir.hands_feet || vir.hands,
        non_human: vir.non_human || vir.limb_config,
        marks: vir.marks,
        outfit: vir.outfit || vir.outfit_layers,
        underwear: vir.underwear,
        accessories: vir.accessories,
        equipment: vir.equipment,
        holding: vir.holding || vir.held_items || vir.in_hands,
        pose: vir.pose || vir.posture || vir.posture_voice,
        expression: vir.expression || vir.default_expression,
        condition: compactValue([
            vir.condition,
            vir.aftermath_marks || (Number(vir.aftermath) > 0 ? `aftermath active (${vir.aftermath} turns)` : ''),
            vir.body_fluids,
            vir.injuries,
            vir.dishevelment,
        ]),
        location: vir.location_context || vir.location,
        dialogue_color: vir.voice_lock?.dialogue_color,
    };
}

function joinList(arr, sep = '; ') {
    if (!Array.isArray(arr)) return arr ? String(arr) : '';
    return arr.filter(Boolean).map(String).join(sep);
}

// ── COMPACT renderer (≤128 tok target) ─────────────────────────────────────
// One short paragraph, prose+semicolons. Identity-load-bearing fields only.
function renderCompact(name, vir = {}) {
    const v = virExtract(vir);
    const identity = [
        v.species,
        v.age && `age ${String(v.age).replace(/[a-z]+$/i, '').trim() || v.age}`,
        v.build,
        v.hair,
        v.eyes && `${v.eyes} eyes`,
        v.skin && `${v.skin} skin`,
    ].filter(Boolean).join(', ');
    const nonHumanShort = v.non_human ? compactValue(v.non_human) : '';
    const outfitShort = joinList(v.outfit, ', ');
    const stateBits = [v.pose, v.expression].filter(Boolean).join(', ');
    const parts = [`[VIR: ${name}]`];
    if (v.source) parts.push(`from ${v.source}`);
    if (identity) parts.push(`${identity}.`);
    if (nonHumanShort) parts.push(`${nonHumanShort}.`);
    if (outfitShort) parts.push(`Outfit: ${outfitShort}.`);
    if (stateBits) parts.push(`${stateBits}.`);
    return parts.join(' ');
}

// ── STANDARD renderer (≤192 tok target) ────────────────────────────────────
// Two paragraphs: Identity (anchor facts) + State (current scene).
function renderStandard(name, vir = {}) {
    const v = virExtract(vir);
    const out = [];
    out.push(`[VIR: ${name}]`);
    if (v.source) out.push(`Source: ${v.source}.`);
    const idBits = [
        v.species,
        v.age && `age ${String(v.age).replace(/[a-z]+$/i, '').trim() || v.age}`,
        v.height,
        v.build,
    ].filter(Boolean).join(', ');
    const identitySentence = [
        idBits,
        v.hair && `hair: ${v.hair}`,
        v.eyes && `eyes: ${v.eyes}`,
        v.skin && `skin: ${v.skin}`,
        v.face && `face: ${compactValue(v.face)}`,
        v.body && `body: ${compactValue(v.body)}`,
        v.non_human && `${compactValue(v.non_human)}`,
        v.marks && `marks: ${compactValue(v.marks)}`,
    ].filter(Boolean).join('; ');
    if (identitySentence) out.push(`Identity: ${identitySentence}.`);

    const outfitText = joinList(v.outfit, '; ');
    const accessoryText = Array.isArray(v.accessories) && v.accessories.length
        ? v.accessories.slice(0, 2).join('; ') : '';
    const stateBits = [
        outfitText && `outfit: ${outfitText}`,
        v.underwear && Array.isArray(v.underwear) && v.underwear.length && `underwear: ${joinList(v.underwear, ', ')}`,
        accessoryText && `accessories: ${accessoryText}`,
        v.holding && `holding: ${compactValue(v.holding)}`,
        v.pose && `pose: ${v.pose}`,
        v.expression && `expression: ${v.expression}`,
        v.condition && `condition: ${v.condition}`,
    ].filter(Boolean).join('; ');
    if (stateBits) out.push(`State: ${stateBits}.`);

    if (v.location) out.push(`Location: ${v.location}.`);
    if (v.dialogue_color) out.push(`Dialogue colour: ${v.dialogue_color}.`);
    return out.join('\n');
}

// ── DETAILED renderer (≤256 tok target) ────────────────────────────────────
// Full locked card. Every populated field present, compressed phrasing,
// empty fields omitted entirely (no blank label rows).
function renderDetailed(name, vir = {}) {
    const v = virExtract(vir);
    const rows = [
        `[LOCKED VISUAL CARD: ${name}]`,
        '# --- STABLE IDENTITY ---',
        `PIC_IDENTITY: ${buildPicIdentity(name, vir)}`,
        `IDENTITY: ${compactValue([v.species, v.source, v.age, v.height, v.build])}`,
        v.body_material && `BODY_MATERIAL: ${compactValue(v.body_material)}`,
        v.hair && `HAIR: ${compactValue(v.hair)}`,
        v.eyes && `EYES: ${compactValue(v.eyes)}`,
        v.face && `FACE_FEATURES: ${compactValue(v.face)}`,
        v.brow_lash && `BROW_LASH: ${compactValue(v.brow_lash)}`,
        v.lips_teeth && `LIPS_TEETH: ${compactValue(v.lips_teeth)}`,
        v.skin && `SKIN/FUR/SCALES: ${compactValue(v.skin)}`,
        (v.body || v.anatomy) && `BODY/ANATOMY: ${compactValue([v.body, v.anatomy])}`,
        v.hands_feet && `HANDS_FEET: ${compactValue(v.hands_feet)}`,
        v.non_human && `NON-HUMAN: ${compactValue(v.non_human)}`,
        v.marks && `MARKS: ${compactValue(v.marks)}`,
        '# --- CURRENT STATE ---',
        v.hair_state && `HAIR_NOW: ${compactValue(v.hair_state)}`,
        ...compactList('OUTFIT ', v.outfit),
        ...compactList('UNDERWEAR ', v.underwear),
        ...compactList('ACCESSORY ', v.accessories),
        ...compactList('EQUIPMENT ', v.equipment),
        v.holding && `HOLDING: ${compactValue(v.holding)}`,
        v.pose && `POSE: ${compactValue(v.pose)}`,
        v.expression && `EXPRESSION: ${compactValue(v.expression)}`,
        v.condition && `CONDITION: ${v.condition}`,
        v.location && `LOCATION_CONTEXT: ${compactValue(v.location)}`,
        v.dialogue_color && `DIALOGUE_COLOR: ${v.dialogue_color}`,
        `[/LOCKED VISUAL CARD]`,
    ].filter(line => {
        if (!line) return false;
        if (line.startsWith('# ---')) return true;
        if (typeof line === 'string' && (line.endsWith(': ') || line.endsWith(':'))) return false;
        return true;
    });
    return rows.join('\n');
}

// ── Budget enforcement ─────────────────────────────────────────────────────
// If the rendered text exceeds the template's hard cap, drop fields in this
// order (least → most essential). Used as a safety net only; templates aim
// well under cap so this rarely fires.
const FIELD_DROP_ORDER = {
    Detailed: ['body_material', 'brow_lash', 'lips_teeth', 'hands_feet', 'marks_extra', 'accessories_extra', 'equipment_extra'],
    Standard: ['face', 'non_human_detail', 'marks', 'accessories_extra', 'underwear'],
    Compact:  ['non_human_short', 'skin', 'outfit_short'],
};
function enforceBudget(text, maxTokens, template, vir, name) {
    if (estimateTokens(text) <= maxTokens) return text;
    // Best-effort retry: progressively render with lower templates if over cap.
    if (template === 'Detailed') {
        const standardText = renderStandard(name, vir);
        if (estimateTokens(standardText) <= maxTokens) return standardText;
        const compactText = renderCompact(name, vir);
        if (estimateTokens(compactText) <= maxTokens) return compactText;
        return compactText; // accept overflow rather than identity loss
    }
    if (template === 'Standard') {
        const compactText = renderCompact(name, vir);
        if (estimateTokens(compactText) <= maxTokens) return compactText;
        return compactText;
    }
    return text; // Compact already at floor; let it overflow rather than corrupt
}

// ── Dispatcher ─────────────────────────────────────────────────────────────
function renderEntry(name, vir, templateName) {
    const tplName = templateName || getEffectiveTemplate();
    const mode = resolveTemplateMode(tplName);
    const label = mode.label;
    let text;
    switch (label) {
        case 'Compact':  text = renderCompact(name, vir); break;
        case 'Standard': text = renderStandard(name, vir); break;
        default:         text = renderDetailed(name, vir); break;
    }
    return enforceBudget(text, mode.budgetTokens, label, vir, name);
}

// Back-compat alias — older code calls lockedVisualCard().
function lockedVisualCard(name, vir = {}) {
    return renderEntry(name, vir);
}

function characterContent(name, payload = {}, templateName) {
    const vir = payload.vir || payload;
    const picIdentity = buildPicIdentity(name, vir);
    // v6 — render via per-template dispatcher (Compact / Standard / Detailed).
    // Falls back to settings().templateMode when not specified, matching
    // the rest of the codebase. The dispatcher enforces the per-template
    // token cap (128 / 192 / 256) so the rendered entry never exceeds
    // budget.
    return `[ACTIVE VIR: ${name}]
Canonical name+source for image prompts: ${picIdentity || name}
${renderEntry(name, vir, templateName)}
[/ACTIVE VIR]`;
}

function normalizeLegacyPicCopy(entry) {
    if (!entry?.content || !/\[PIC COPY:/i.test(String(entry.content))) return false;
    const name = characterEntryName(entry);
    if (!name) return false;
    const vir = parseActiveVir(entry.content || '');
    entry.content = characterContent(name, { vir });
    return true;
}

function parseActiveVir(content) {
    const m = String(content || '').match(/\[ACTIVE VIR:[^\]]+\]\s*([\s\S]*?)\s*\[\/ACTIVE VIR\]/);
    if (!m) return {};
    const body = m[1];
    const cardVir = parseCardLines(body);
    if (Object.keys(cardVir).length) return cardVir;
    return parseInlineVirLines(body);
}

function extractPicCopy(content) {
    const m = String(content || '').match(/\[PIC COPY:[^\]]+\]\s*([\s\S]*?)\s*\[\/PIC COPY\]/i);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function parseCardLines(body) {
    const vir = {};
    const cardMatch = body.match(/\[LOCKED VISUAL CARD:[^\]]+\]([\s\S]*?)\[\/LOCKED VISUAL CARD\]/);
    if (!cardMatch) return {};
    for (const line of cardMatch[1].split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('# ---')) continue; // skip section-header comments
        const idx = t.indexOf(':');
        if (idx < 1) continue;
        const k = t.slice(0, idx).trim();
        const v = t.slice(idx + 1).trim();
        if (!v) continue;
        if (/^OUTFIT\s+\d+/i.test(k)) { (vir.outfit = vir.outfit || []).push(v); }
        else if (/^UNDERWEAR\s+\d+/i.test(k)) { (vir.underwear = vir.underwear || []).push(v); }
        else if (/^ACCESSORY\s+\d+/i.test(k)) { (vir.accessories = vir.accessories || []).push(v); }
        else if (/^EQUIPMENT\s+\d+/i.test(k)) { (vir.equipment = vir.equipment || []).push(v); }
        else if (k === 'BODY_MATERIAL') vir.body_material = v;
        else if (k === 'HAIR') vir.hair = v;
        else if (k === 'HAIR_NOW') vir.hair_state = v;
        else if (k === 'EYES') vir.eyes = v;
        else if (k === 'FACE_FEATURES') vir.face_features = v;
        else if (k === 'BROW_LASH') vir.brow_lash = v;
        else if (k === 'LIPS_TEETH') vir.lips_teeth = v;
        else if (k === 'SKIN/FUR/SCALES') vir.skin_fur_scales = v;
        else if (k === 'BODY/ANATOMY') vir.body = v;
        else if (k === 'HANDS_FEET') vir.hands_feet = v;
        else if (k === 'POSTURE_VOICE') vir.posture_voice = v;
        else if (k === 'POSE') vir.pose = v;
        else if (k === 'EXPRESSION') vir.expression = v;
        else if (k === 'HOLDING') vir.holding = v;
        else if (k === 'CONDITION') vir.condition = v;
        else if (k === 'LOCATION_CONTEXT') vir.location_context = v;
        else if (k === 'NON-HUMAN') vir.non_human = v;
        else if (k === 'MARKS') vir.marks = v;
        else if (k === 'DIALOGUE_COLOR') { vir.voice_lock = vir.voice_lock || {}; vir.voice_lock.dialogue_color = v; }
        else if (k === 'IDENTITY') {
            const parts = splitPackedFacts(v);
            if (parts[0]) vir.species = parts[0];
            const buildBits = [];
            for (const part of parts.slice(1)) {
                if (!vir.source && /\b(original|canon|franchise|from)\b/i.test(part)) vir.source = part;
                else if (!vir.height && /(\d+\s*cm|\bcm\b|\bfeet\b|\bft\b|tall)/i.test(part)) vir.height = part;
                else if (!vir.age_appearance && /\b(looks|mid|late|early|teen|20s|30s|40s|50s|adult|young|old)\b/i.test(part)) vir.age_appearance = part;
                else buildBits.push(part);
            }
            if (buildBits.length) vir.build = buildBits.join('; ');
        }
    }
    return vir;
}

function parseIdentitySummary(text, vir) {
    const parts = String(text || '').split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    if (!vir.species) vir.species = parts[0];
    const buildBits = [];
    for (const part of parts.slice(1)) {
        if (!vir.age_appearance && /^age\b/i.test(part)) {
            vir.age_appearance = part.replace(/^age\s*/i, '').trim();
        } else if (!vir.height && /(\d+\s*cm|\bcm\b|\bfeet\b|\bft\b|tall)/i.test(part)) {
            vir.height = part;
        } else if (!vir.hair && /\bhair\b/i.test(part)) {
            vir.hair = part;
        } else if (!vir.eyes && /\beyes?\b/i.test(part)) {
            vir.eyes = part.replace(/\seyes?$/i, '').trim();
        } else if (!vir.skin_fur_scales && /\bskin\b/i.test(part)) {
            vir.skin_fur_scales = part.replace(/\sskin$/i, '').trim();
        } else {
            buildBits.push(part);
        }
    }
    if (buildBits.length && !vir.build) vir.build = buildBits.join('; ');
}

function parseInlineVirLines(body) {
    const vir = {};
    let text = String(body || '')
        .replace(/^Canonical name\+source for image prompts:.*$/gim, '')
        .trim();
    if (!text) return vir;

    const sourceMatch = text.match(/(?:^|\n)Source:\s*([^.]+)\./i);
    if (sourceMatch) vir.source = sourceMatch[1].trim();

    const identityMatch = text.match(/(?:^|\n)Identity:\s*([\s\S]*?)(?=\nState:|\nLocation:|\nDialogue colour:|$)/i);
    if (identityMatch) {
        const segments = identityMatch[1].replace(/\s+/g, ' ').trim().replace(/\.$/, '').split(/\s*;\s*/).filter(Boolean);
        if (segments.length) parseIdentitySummary(segments[0], vir);
        for (const segment of segments.slice(1)) {
            if (!vir.hair && /^hair:/i.test(segment)) vir.hair = segment.replace(/^hair:\s*/i, '').trim();
            else if (!vir.eyes && /^eyes:/i.test(segment)) vir.eyes = segment.replace(/^eyes:\s*/i, '').trim();
            else if (!vir.skin_fur_scales && /^skin:/i.test(segment)) vir.skin_fur_scales = segment.replace(/^skin:\s*/i, '').trim();
            else if (!vir.face_features && /^face:/i.test(segment)) vir.face_features = segment.replace(/^face:\s*/i, '').trim();
            else if (!vir.body && /^body:/i.test(segment)) vir.body = segment.replace(/^body:\s*/i, '').trim();
            else if (!vir.marks && /^marks:/i.test(segment)) vir.marks = segment.replace(/^marks:\s*/i, '').trim();
            else if (!vir.non_human) vir.non_human = segment.trim();
        }
    }

    const stateMatch = text.match(/(?:^|\n)State:\s*([\s\S]*?)(?=\nLocation:|\nDialogue colour:|$)/i);
    if (stateMatch) {
        const segments = stateMatch[1].replace(/\s+/g, ' ').trim().replace(/\.$/, '').split(/\s*;\s*/).filter(Boolean);
        for (const segment of segments) {
            if (/^outfit:/i.test(segment)) vir.outfit = splitPackedFacts(segment.replace(/^outfit:\s*/i, ''));
            else if (/^underwear:/i.test(segment)) vir.underwear = splitPackedFacts(segment.replace(/^underwear:\s*/i, ''));
            else if (/^accessories:/i.test(segment)) vir.accessories = splitPackedFacts(segment.replace(/^accessories:\s*/i, ''));
            else if (/^holding:/i.test(segment)) vir.holding = segment.replace(/^holding:\s*/i, '').trim();
            else if (/^pose:/i.test(segment)) vir.pose = segment.replace(/^pose:\s*/i, '').trim();
            else if (/^expression:/i.test(segment)) vir.expression = segment.replace(/^expression:\s*/i, '').trim();
            else if (/^condition:/i.test(segment)) vir.condition = segment.replace(/^condition:\s*/i, '').trim();
        }
    }

    const locationMatch = text.match(/(?:^|\n)Location:\s*([^.]+)\./i);
    if (locationMatch) vir.location_context = locationMatch[1].trim();
    const colorMatch = text.match(/(?:^|\n)Dialogue colour:\s*(#[0-9a-f]{3,8})\./i);
    if (colorMatch) {
        vir.voice_lock = vir.voice_lock || {};
        vir.voice_lock.dialogue_color = colorMatch[1].trim();
    }

    if (!Object.keys(vir).length) {
        text = text.replace(/^\[VIR:[^\]]+\]\s*/i, '').trim();
        const outfitMatch = text.match(/Outfit:\s*([^.\n]+)\./i);
        if (outfitMatch) vir.outfit = splitPackedFacts(outfitMatch[1]);
        const poseTail = outfitMatch ? text.slice(text.indexOf(outfitMatch[0]) + outfitMatch[0].length).trim() : '';
        if (poseTail) {
            const stateParts = poseTail.replace(/\.$/, '').split(/\s*,\s*/).filter(Boolean);
            if (stateParts.length) {
                vir.pose = stateParts[0].trim();
                if (stateParts.length > 1) vir.expression = stateParts.slice(1).join(', ').trim();
            }
        }
        const beforeOutfit = outfitMatch ? text.slice(0, text.indexOf(outfitMatch[0])).trim() : text;
        const sentences = beforeOutfit.split(/\.\s*/).map(s => s.trim()).filter(Boolean);
        if (sentences.length) parseIdentitySummary(sentences[0].replace(/^from\s+/i, ''), vir);
        if (sentences.length > 1 && !vir.non_human) vir.non_human = sentences[1];
    }

    return vir;
}

function mergeVir(oldVir, delta) {
    if (!oldVir || typeof oldVir !== 'object') return structuredClone(delta || {});
    const result = structuredClone(oldVir);
    for (const [key, value] of Object.entries(delta || {})) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeVir(result[key], value) : value;
    }
    return result;
}

function canonicalizeName(rawName, payload) {
    const aliases = uniqueClean(payload?.aliases || []);
    let canonical = String(rawName || '').trim();
    canonical = canonical.replace(/\s*[(\[][^)\]]*[)\]]\s*/g, ' ').trim();
    canonical = canonical.replace(/\s+/g, ' ').trim();
    return { canonical, aliases };
}

// ============================================================================
// CHARACTER ENTRY MANAGEMENT
// ============================================================================
function characterEntryName(entry) {
    const commentName = String(entry?.comment || '').replace(/^VIR:\s*/i, '').trim();
    if (commentName && commentName !== entry?.comment) return commentName;
    const m = String(entry?.content || '').match(/\[ACTIVE VIR:\s*([^\]]+)\]/i);
    return m?.[1]?.trim() || '';
}
function characterEntries(data) {
    return Object.entries(getEntries(data)).filter(([, entry]) => {
        if (!entry) return false;
        // v6 §3.2: also exclude the new Recovery entry from the per-character views.
        if (entry.comment === 'FF4 VIR Rules' || entry.comment === 'FF4 VIR Recovery' ||
            entry.comment === 'FF4 FF4_STATE' || entry.comment === 'FF4 VIR Roster') return false;
        return Boolean(characterEntryName(entry));
    });
}
function characterCount(data) { return characterEntries(data).length; }
function findCharacterEntry(data, name) {
    const target = canonicalizeName(name).canonical.toLowerCase();
    return Object.values(getEntries(data)).find(entry => {
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'FF4 VIR Recovery') return false;
        const entryName = String(entry.comment || '').replace(/^VIR:\s*/i, '');
        if (canonicalizeName(entryName).canonical.toLowerCase() === target) return true;
        if (String(entry.content || '').toLowerCase().includes(`[active vir: ${target}]`)) return true;
        return (entry.key || []).some(key => canonicalizeName(key).canonical.toLowerCase() === target);
    });
}

function upsertCharacter(data, name, payload) {
    if (!name || !payload) return null;
    const entries = getEntries(data);
    const nameInfo = canonicalizeName(name, payload);
    name = nameInfo.canonical;
    const aliases = uniqueClean([...(Array.isArray(payload.aliases) ? payload.aliases : []), ...nameInfo.aliases]);
    const vir = payload.vir || payload;
    const key = uniqueClean([name, ...aliases]);
    let entry = findCharacterEntry(data, name);
    if (!entry) {
        const uid = nextUid(data);
        entry = enforceVirRecursionFlags(makeEntry({
            uid, key, comment: `VIR: ${name}`, content: characterContent(name, { vir }),
            constant: false,  // tier system applies actual constant flag
            order: TIER.OFFSCREEN.order, depth: TIER.OFFSCREEN.depth, position: 4,
        }));
        entries[uid] = entry;
    } else {
        entry.key = uniqueClean([...(entry.key || []), ...key]);
        entry.comment = `VIR: ${name}`;
        entry.content = characterContent(name, { vir });
        entry.disable = false;
        enforceVirRecursionFlags(entry);
    }
    return entry;
}

// v6 P1-6 — detect sparse VIR (corrupted or partially populated entries).
// Used by applyDelta() to decide whether to merge or replace.
const VIR_CORE_ANCHORS = ['species', 'hair', 'eyes', 'age_appearance', 'build', 'skin_fur_scales'];
function entryIsSparse(vir) {
    if (!vir || typeof vir !== 'object') return true;
    const populated = VIR_CORE_ANCHORS.filter(k => {
        const v = vir[k] || (k === 'skin_fur_scales' && (vir.skin || vir.fur || vir.scales));
        return typeof v === 'string' && v.trim().length > 0;
    }).length;
    return populated < Math.ceil(VIR_CORE_ANCHORS.length * 0.4); // < 40% populated
}
function deltaIsSubstantive(delta) {
    if (!delta || typeof delta !== 'object') return false;
    const populated = VIR_CORE_ANCHORS.filter(k => {
        const v = delta[k] || (k === 'skin_fur_scales' && (delta.skin || delta.fur || delta.scales));
        return typeof v === 'string' && v.trim().length > 0;
    }).length;
    return populated >= Math.ceil(VIR_CORE_ANCHORS.length * 0.5); // ≥ 50%
}

function applyDelta(data, name, delta) {
    if (!name || !delta) return;
    name = canonicalizeName(name, delta).canonical;
    const current = findCharacterEntry(data, name);
    const oldVir = current ? parseActiveVir(current.content) : {};
    if (current) checkVirDrift(name, oldVir, delta);
    // v6 P1-6: if the stored entry is sparse AND the incoming delta is substantive
    // (looks more like a refresh than a delta), use the delta as the new ground
    // truth instead of merging missing fields onto a corrupted base. Prevents
    // perpetual sparseness for characters whose first save was incomplete.
    let nextVir;
    if (current && entryIsSparse(oldVir) && deltaIsSubstantive(delta)) {
        log(`Delta backfill: ${name} stored entry sparse, incoming delta substantive — using delta as base`);
        nextVir = mergeVir(delta, oldVir); // delta first, then non-conflicting old fields
    } else {
        nextVir = mergeVir(oldVir, delta);
    }
    return upsertCharacter(data, name, { vir: nextVir });
}

// ============================================================================
// USER PERSONA SEEDING (Phase 1)
// Two paths now keep {{user}} tracked:
//  1. This seeder — reads the active persona description, extracts a best-effort
//     VIR, and seeds a pinned entry. Requires a non-empty persona description.
//  2. The VIR contract also instructs the AI to draft a {{user}} VIR entry from
//     the story itself, so {{user}} is tracked even with a blank persona.
// When both fire, they converge on the same name-keyed entry; the seeder backs
// off once the AI has enriched it (see aiEnriched check below).
// ============================================================================

// Lightweight extraction of structured fields from a freeform persona
// description. Handles "Key: value", "**Key:** value", "- Key: value".
function personaToVir(desc) {
    const text = String(desc || '');
    if (!text.trim()) return null;
    const vir = {};
    const grab = (patterns) => {
        for (const re of patterns) {
            const m = text.match(re);
            if (m && m[1] && m[1].trim()) return m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
        }
        return '';
    };
    const k = (label) => [
        new RegExp(`(?:^|\\n)\\s*\\**\\s*${label}\\s*\\**\\s*[:\\-=]\\s*([^\\n]+)`, 'i'),
    ];
    const look = grab(k('look|appearance|visual|looks'));
    const nationality = grab(k('nationality|ethnicity'));
    const personaName = grab(k('name'));

    vir.species = grab(k('species|race'));
    if (!vir.species) {
        if (/\b(man|male|guy|boy|he|him)\b/i.test(text)) vir.species = 'adult human male';
        else if (/\b(woman|female|girl|she|her)\b/i.test(text)) vir.species = 'adult human female';
        else vir.species = 'human';
    }
    vir.age_appearance = grab(k('age|years? old|demographics'));
    vir.height = grab(k('height'));
    vir.build = grab(k('build|physique|body type'));
    vir.hair = grab(k('hair'));
    vir.eyes = grab(k('eyes?|eye colou?r'));
    vir.skin_fur_scales = grab(k('skin|complexion'));
    vir.body = grab(k('body|figure'));
    vir.face_features = grab(k('face|facial features'));
    vir.marks = grab(k('marks|scars|tattoos|piercings'));
    const outfit = grab(k('outfit|clothing|attire|wears|wearing|clothes'));
    if (outfit) vir.outfit = [outfit];
    const accessories = grab(k('accessor(?:y|ies)|jewelry'));
    if (accessories) vir.accessories = [accessories];

    const visualText = [look, text].filter(Boolean).join('\n');
    if (!vir.age_appearance) {
        const m = visualText.match(/\b(?:age\s*)?(\d{2})\b/);
        if (m) vir.age_appearance = `${m[1]} years old`;
    }
    if (!vir.height && /\btall\b/i.test(visualText)) vir.height = 'tall';
    if (!vir.build) {
        const bits = [];
        for (const word of ['muscular', 'fit', 'lean', 'slim', 'average build', 'broad shoulders', 'defined physique', 'fat', 'big']) {
            if (new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i').test(visualText)) bits.push(word);
        }
        if (bits.length) vir.build = uniqueClean(bits).join('; ');
    }
    if (!vir.hair) {
        const m = visualText.match(/\b((?:jet-black|black|dark brown|brown|blond|blonde|red|white|silver|gray|grey)[^.;,\n]{0,45}\bhair)\b/i);
        if (m) vir.hair = m[1];
    }
    if (!vir.eyes) {
        const m = visualText.match(/\b((?:sharp\s+)?(?:dark|black|brown|blue|green|gray|grey|gold|amber)[^.;,\n]{0,35}\beyes)\b/i);
        if (m) vir.eyes = m[1].replace(/\beyes$/i, '').trim();
    }
    if (!vir.skin_fur_scales) {
        const m = visualText.match(/\b(golden-brown skin|brown skin|dark skin|light skin|pale skin|tan skin|fair skin|olive skin)\b/i);
        if (m) vir.skin_fur_scales = m[1];
    }
    if (!vir.body && look) vir.body = look;
    if (nationality && !String(vir.body || '').toLowerCase().includes(nationality.toLowerCase())) {
        vir.body = compactValue([nationality, vir.body]);
    }
    if (personaName) vir.aliases = [personaName];

    // Whatever we couldn't field-map: keep the raw description as context so
    // the AI has the source material when it later emits a delta.
    vir.persona_source = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
    // Drop empty keys
    for (const key of Object.keys(vir)) {
        if (!vir[key] || (Array.isArray(vir[key]) && !vir[key].length)) delete vir[key];
    }
    return Object.keys(vir).length ? vir : null;
}

function virVisualCompleteness(vir = {}) {
    let score = 0;
    for (const key of ['species', 'age_appearance', 'height', 'build', 'hair', 'eyes', 'skin_fur_scales', 'body', 'face_features', 'marks']) {
        if (vir[key]) score++;
    }
    if (Array.isArray(vir.outfit) && vir.outfit.length) score += Math.min(2, vir.outfit.length);
    if (Array.isArray(vir.accessories) && vir.accessories.length) score++;
    return score;
}

function isWeakUserVir(vir = {}) {
    if (virVisualCompleteness(vir) < 8) return true;
    const weakBody = /^(adult )?human( male| female)?$/i.test(String(vir.species || '').trim())
        && /^(average build|slim|fit|tall)?$/i.test(String(vir.build || '').trim());
    const weakOutfit = !Array.isArray(vir.outfit) || vir.outfit.length < 2
        || vir.outfit.some(x => /^(casual dark clothes|casual clothes|clothes|outfit)$/i.test(String(x).trim()));
    return weakBody || weakOutfit || !vir.hair || !vir.eyes || !vir.skin_fur_scales;
}

// Seed (or refresh) the {{user}} persona VIR entry and pin it.
function seedUserPersonaVir(worldName, data) {
    try {
        if (settings().seedUserPersona === false) return;
        const personaName = String(name1 || '').trim();
        const desc = String(power_user?.persona_description || '').trim();
        if (!personaName || !desc) return;

        const vir = personaToVir(desc);
        if (!vir) return;

        const existing = findCharacterEntry(data, personaName);
        let finalVir = vir;
        if (existing) {
            // Don't clobber an entry the AI has already enriched — only seed
            // if the entry still looks like a bare seed (no AI delta yet).
            const existingVir = parseActiveVir(existing.content || '');
            const aiEnriched = !isWeakUserVir(existingVir) && (existingVir.hair_state ||
                existingVir.condition || existingVir.holding);
            if (aiEnriched) return;
            finalVir = mergeVir(existingVir, vir);
        }
        const entry = upsertCharacter(data, personaName, { vir: finalVir });
        if (!entry) return;
        // Tag so we can recognise the user persona entry later.
        entry.comment = `VIR: ${personaName}`;
        if (Array.isArray(entry.key) && !entry.key.includes('{{user}}')) {
            entry.key = [...entry.key, '{{user}}'];
        }
        // Pin it — the user is always in scene.
        const canonical = canonicalizeName(personaName).canonical;
        if (pinCharacter(worldName, canonical)) {
            log(`Seeded user persona VIR: ${personaName} (pinned)`);
        } else {
            log(`Seeded user persona VIR: ${personaName} (already pinned)`);
        }
    } catch (e) {
        warn('seedUserPersonaVir failed', e);
    }
}

// ============================================================================
// SMART TIER APPLICATION
// ============================================================================
function setActiveFlags(data, activeNames, pinnedNames = new Set(), recallNames = new Set()) {
    const smart = settings().smartTiers !== false;
    for (const entry of Object.values(getEntries(data))) {
        // Skip non-character entries — character-tier flags don't apply to them.
        // v6: also skip the new Recovery entry whose constant flag is managed
        // separately by ensureRecoveryEntry().
        if (!entry || entry.comment === RULES_ENTRY_COMMENT || entry.comment === RECOVERY_ENTRY_COMMENT ||
            entry.comment === 'FF4 FF4_STATE' || entry.comment === 'FF4 VIR Roster') continue;
        const name = characterEntryName(entry);
        if (!name) continue;
        normalizeLegacyPicCopy(entry);
        enforceVirRecursionFlags(entry);
        const userEntry = isUserVirEntry(entry);
        if (pinnedNames.has(name)) {
            entry.constant = userEntry; entry.order = TIER.PINNED.order; entry.depth = TIER.PINNED.depth;
        } else if (activeNames.has(name)) {
            entry.constant = userEntry; entry.order = TIER.ACTIVE.order; entry.depth = TIER.ACTIVE.depth;
        } else if (recallNames.has(name)) {
            entry.constant = userEntry; entry.order = TIER.RECALL.order; entry.depth = TIER.RECALL.depth;
        } else {
            // OFFSCREEN — smart mode: keyword-only (no constant); else: behave like active
            if (smart) {
                entry.constant = userEntry; entry.order = TIER.OFFSCREEN.order; entry.depth = TIER.OFFSCREEN.depth;
            } else {
                entry.constant = userEntry; entry.order = TIER.ACTIVE.order; entry.depth = TIER.ACTIVE.depth;
            }
        }
    }
}

function getCharacterTierInfo(entry, name, pinnedNames = new Set(), recallMap = {}) {
    if (pinnedNames.has(name)) return { tier: 'PIN', color: '#FFD180', reason: 'pinned keyword-triggered' };
    if (recallMap[name]) return { tier: `RCL${recallMap[name]}`, color: '#B39DDB', reason: `recall ${recallMap[name]} turns keyword-triggered` };
    if (entry?.order === TIER.ACTIVE.order && entry?.depth === TIER.ACTIVE.depth) {
        return { tier: 'ACT', color: '#A5D6A7', reason: 'active keyword-triggered' };
    }
    return { tier: 'OFF', color: '#aab4c0', reason: 'offscreen keyword-only' };
}
function activeNamesFrom(sync) {
    const names = new Set();
    for (const name of Object.keys(sync.new_characters || {})) names.add(name);
    for (const name of Object.keys(sync.vir_delta || {})) names.add(name);
    // Schema 3: scene.active (comma-separated string or array)
    if (sync.scene?.active) {
        const actives = typeof sync.scene.active === 'string'
            ? sync.scene.active.split(/\s*,\s*/).filter(Boolean)
            : Array.isArray(sync.scene.active) ? sync.scene.active : [];
        for (const name of actives) names.add(name);
    }
    // Schema 3: characters[] with action !== 'update'
    if (Array.isArray(sync.characters)) {
        for (const char of sync.characters) {
            if (char?.name && char.action !== 'update') names.add(char.name);
        }
    }
    return names;
}

// ============================================================================
// DIALOGUE COLOR AUTO-ASSIGNMENT (palette, light/bright only for dark theme)
// ============================================================================
function assignDialogueColors(data) {
    const chars = characterEntries(data);
    const used = new Set();
    const queue = [];
    for (const [, entry] of chars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        const vir = parseActiveVir(entry.content || '');
        if (vir?.voice_lock?.dialogue_color) used.add(String(vir.voice_lock.dialogue_color).toUpperCase());
        else queue.push({ entry, name, vir });
    }
    let changed = false;
    for (const { entry, name, vir } of queue) {
        const available = DIALOGUE_PALETTE.find(c => !used.has(c.toUpperCase()));
        const color = available || DIALOGUE_PALETTE[Math.floor(Math.random() * DIALOGUE_PALETTE.length)];
        used.add(color.toUpperCase());
        if (!vir.voice_lock) vir.voice_lock = {};
        vir.voice_lock.dialogue_color = color;
        entry.content = characterContent(name, { vir });
        changed = true;
    }
    return changed;
}

// ============================================================================
// FF4_STATE — REMOVED from lorebook (v5.1.0)
// State is now injected via setExtensionPrompt only. This function cleans up
// any leftover FF4_STATE lorebook entry from previous versions.
// ============================================================================
function ensureFF4StateEntry(data) {
    const entries = getEntries(data);
    const entry = Object.values(entries).find(e => e?.comment === 'FF4 FF4_STATE');
    if (entry) {
        delete entries[entry.uid];
        log('Removed obsolete FF4 FF4_STATE lorebook entry');
    }
}

// SCENE_STATE — cleanup only: remove any leftover lorebook entry from previous versions
function cleanupSceneStateEntry(data) {
    const entries = getEntries(data);
    const entry = Object.values(entries).find(e => e?.comment === 'FF4 SCENE_STATE');
    if (entry) {
        delete entries[entry.uid];
        log('Removed obsolete FF4 SCENE_STATE lorebook entry');
    }
}

// ============================================================================
// VIR ROSTER (always-on compact reference of all known chars)
// ============================================================================
function buildRosterContent(data) {
    const chars = characterEntries(data);
    if (!chars.length) return '';
    const lines = ['[VIR_ROSTER]'];
    for (const [, entry] of chars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        const vir = parseActiveVir(entry.content || '');
        const id = [vir.species, vir.source].filter(Boolean).join('/');
        const hairBrief = vir.hair ? String(vir.hair).split(',')[0].slice(0, 40) : '';
        lines.push(`- ${name}${id ? `: ${id}` : ''}${hairBrief ? `; ${hairBrief}` : ''}`);
    }
    lines.push('USE: emit recall_characters:["Name"] to re-activate a long-absent char.');
    lines.push('[/VIR_ROSTER]');
    return lines.join('\n');
}
function findRosterEntry(data) {
    return Object.values(getEntries(data)).find(e => e?.comment === 'FF4 VIR Roster');
}
function rebuildRosterEntry(data) {
    const entries = getEntries(data);
    let entry = findRosterEntry(data);
    const content = buildRosterContent(data);
    if (!entry) {
        if (!content) return null;
        const uid = nextUid(data);
        // preventRecursion: the roster is constant=true and lists every known
        // character name. Without preventRecursion, its content would cascade-
        // trigger every character VIR entry on every turn — destroying the
        // tier/selective system. excludeRecursion is belt-and-braces (nothing
        // should ever trigger an always-on entry).
        entry = enforceVirRecursionFlags(makeEntry({ uid, key: ['VIR_ROSTER'], comment: 'FF4 VIR Roster', content, constant: true, order: 43, depth: 1, position: 0, excludeRecursion: true, preventRecursion: true }));
        entries[uid] = entry;
    } else if (content) {
        entry.content = content;
        // Force-apply recursion flags on rebuild — rosters from pre-fix
        // versions lacked them and were cascade-triggering every char entry.
        enforceVirRecursionFlags(entry);
    } else {
        delete entries[entry.uid];
    }
    return entry;
}

// ============================================================================
// VIR RULES + RECOVERY entries — v6 §3.2
// Section 3.2 of the v6 plan moved the contract + parse-miss reminder out of
// ephemeral setExtensionPrompt slots and into actual lorebook entries:
//   • "FF4 VIR Rules"    — constant=true, no keywords, contains the contract
//                           (rules + budget + template-mode block). Always
//                           injected by ST's native engine.
//   • "FF4 VIR Recovery" — constant=true only when escalated (parse miss),
//                           constant=false otherwise. Holds the high-priority
//                           reminder. Acts as a one-turn escalation primer.
//
// Why the change: prior versions used setExtensionPrompt for both, which the
// user could not see/edit/disable from ST's lorebook UI. Now both are
// regular entries — user can verify they exist, tweak content if needed,
// and they survive ST restarts because they're persisted in the world file.
//
// setExtensionPrompt is kept as a redundant safety net (zero-cost when the
// content is identical to the lorebook entry — ST de-duplicates). v6.1 may
// remove the setExtensionPrompt path entirely once this design has bedded in.
// ============================================================================
const RULES_ENTRY_COMMENT = 'FF4 VIR Rules';
const RECOVERY_ENTRY_COMMENT = 'FF4 VIR Recovery';
const RULES_ORDER = 50;
const RECOVERY_ORDER = 90;

function ensureSchemaEntry(data) {
    // v6 — repurposed: maintain (not remove) the "FF4 VIR Rules" lorebook
    // entry with the current contract content. Called from ensureWorldLoaded
    // and processSyncPacket so it stays in sync with template-mode changes.
    const entries = getEntries(data);
    let entry = Object.values(entries).find(e => e?.comment === RULES_ENTRY_COMMENT);
    const mode = resolveTemplateMode(getEffectiveTemplate());
    const content = `${VIR_CONTRACT}\n\n${buildVirBudgetBlock()}\n\n${buildTemplateModeBlock(mode)}`;
    if (!entry) {
        const uid = nextUid(data);
        entry = enforceVirRecursionFlags(makeEntry({
            uid,
            key: [],
            comment: RULES_ENTRY_COMMENT,
            content,
            constant: true,
            order: RULES_ORDER,
            depth: VIR_CONTRACT_DEPTH,
            position: 0,
            excludeRecursion: true,
            preventRecursion: true,
        }));
        entries[uid] = entry;
        log(`Created lorebook entry: ${RULES_ENTRY_COMMENT}`);
    } else {
        // Update content if template mode (and therefore the budget/mode block) changed.
        if (entry.content !== content) entry.content = content;
        entry.constant = true;
        entry.order = RULES_ORDER;
        entry.depth = VIR_CONTRACT_DEPTH;
        entry.disable = false;
        enforceVirRecursionFlags(entry);
    }
    return entry;
}

function ensureRecoveryEntry(data) {
    // Recovery entry: constant=true ONLY when the AI has been missing the
    // vir packet (priority escalation). Otherwise constant=false so it
    // doesn't bloat the context unnecessarily.
    const entries = getEntries(data);
    let entry = Object.values(entries).find(e => e?.comment === RECOVERY_ENTRY_COMMENT);
    const escalated = (settings().consecutiveMisses || 0) > 0;
    const content = buildPriorityReminder();
    if (!entry) {
        const uid = nextUid(data);
        entry = enforceVirRecursionFlags(makeEntry({
            uid,
            // Keyword fallback — even when not escalated, if the AI happens to
            // discuss "vir" or "visual identity" we want this reminder to fire.
            key: ['vir', 'visual identity', 'character sheet'],
            comment: RECOVERY_ENTRY_COMMENT,
            content,
            constant: escalated,
            order: RECOVERY_ORDER,
            depth: VIR_PRIORITY_DEPTH,
            position: 0,
            excludeRecursion: true,
            preventRecursion: true,
        }));
        entries[uid] = entry;
        log(`Created lorebook entry: ${RECOVERY_ENTRY_COMMENT}`);
    } else {
        if (entry.content !== content) entry.content = content;
        entry.constant = escalated;
        entry.order = RECOVERY_ORDER;
        entry.depth = VIR_PRIORITY_DEPTH;
        entry.disable = false;
        enforceVirRecursionFlags(entry);
    }
    return entry;
}

// ============================================================================
// PACKET PARSING — code-fence-aware, truncation-tolerant
// ============================================================================
function maskCodeFences(text) {
    return text.replace(/```\w*[\s\S]*?```/g, m => ' '.repeat(m.length));
}
function findOrphanSyncBlocks(text) {
    if (!text) return [];
    const results = [];
    let cursor = 0;
    // Accept schema 1, 2, OR 3 (flat shape introduced in v5.0.0).
    const OPEN_RE = /\{\s*"schema"\s*:\s*[123]\s*,/g;
    while (true) {
        OPEN_RE.lastIndex = cursor;
        const open = OPEN_RE.exec(text);
        if (!open) break;
        const start = open.index;
        let depth = 0, inStr = false, escape = false, end = -1;
        for (let j = start; j < text.length; j++) {
            const ch = text[j];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
        }
        if (end === -1) break;
        const blob = text.slice(start, end);
        // Schema 1/2 markers: new_characters / vir_delta / scene_state / char_state
        // Schema 3 markers: characters (array) / states (array) / scene / recall
        if (/"(?:new_characters|vir_delta|scene_state|char_state|characters|states|scene|recall)"/.test(blob)) {
            results.push({ start, end, text: blob });
        }
        cursor = end;
    }
    return results;
}
function decodeEntities(text) {
    return String(text || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function extractPackets(text) {
    const packets = [];
    const seen = new Set();
    const addPacket = (raw, body) => {
        const bodyTrim = body.replace(/^```(?:json|vir)?\s*/i, '').replace(/```$/i, '').trim();
        const sig = hashString(bodyTrim);
        if (seen.has(sig)) return;
        seen.add(sig);
        packets.push({ raw, body: bodyTrim, sig });
    };
    // Primary: ```vir code fence
    SYNC_RE_FENCE.lastIndex = 0;
    let m;
    while ((m = SYNC_RE_FENCE.exec(text)) !== null) addPacket(m[0], m[1]);
    // Truncated ```vir without closing fence
    if (!packets.length) {
        const openMatch = text.match(/```vir\b\s*\n?([\s\S]+)$/i);
        if (openMatch && openMatch[1].includes('"schema"')) addPacket(openMatch[0], openMatch[1]);
    }
    // Legacy <vir_sync> XML
    SYNC_RE_XML.lastIndex = 0;
    while ((m = SYNC_RE_XML.exec(text)) !== null) addPacket(m[0], m[1]);
    // HTML-encoded
    if (!packets.length) {
        const decoded = decodeEntities(text);
        SYNC_RE_XML.lastIndex = 0;
        while ((m = SYNC_RE_XML.exec(decoded)) !== null) addPacket(m[0], m[1]);
    }
    // Orphan JSON via brace walker (tail only)
    if (!packets.length) {
        const tail = text.length > TAIL_SCAN_CHARS ? text.slice(-TAIL_SCAN_CHARS) : text;
        for (const blob of findOrphanSyncBlocks(tail)) addPacket(blob.text, blob.text);
    }
    return packets;
}
// Robust 4-pass JSON parser, ported from RPG HUD's robustJsonParse.
// Recovers from common AI emission errors:
//   Pass 1: strict JSON.parse
//   Pass 2: strip block comments, line comments, trailing commas
//   Pass 3: escape literal newlines inside string values
//   Pass 4: truncate at last balanced brace
// Only throws if all 4 passes fail.
function robustJsonParse(rawContent) {
    let attempts = 0;
    let lastErr = null;

    // Strip ```json / ```vir wrapper if AI mistakenly nested code fences
    let content = String(rawContent || '').replace(/^```(?:json|vir)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Pass 1 — strict
    try {
        attempts++;
        return { data: JSON.parse(content), recovered: false, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 2 — strip comments + trailing commas
    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')          // /* block comments */
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')  // // line comments (preserve http://)
            .replace(/,\s*([\}\]])/g, '$1');            // trailing commas
        return { data: JSON.parse(cleaned), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 3 — escape literal newlines inside string values + previous fixes
    try {
        attempts++;
        const repaired = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1')
            .replace(/(?<="[^"\n]*)\n(?=[^"\n]*")/g, '\\n');
        return { data: JSON.parse(repaired), recovered: true, repairAttempts: attempts };
    } catch (e) { lastErr = e; }

    // Pass 4 — truncate at first balanced brace where depth returns to 0
    // (handles "extra closing brace mid-stream" case: stops at first `}` that
    // closes the outer object, ignoring any garbage that follows).
    try {
        attempts++;
        const cleaned = content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
            .replace(/,\s*([\}\]])/g, '$1');
        let depth = 0, inStr = false, escape = false, firstBalanced = -1;
        for (let i = 0; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { firstBalanced = i; break; }  // first close of outer
                if (depth < 0) break;  // unbalanced — bail
            }
        }
        if (firstBalanced > 0) {
            const truncated = cleaned.slice(0, firstBalanced + 1);
            return { data: JSON.parse(truncated), recovered: true, repairAttempts: attempts };
        }
    } catch (e) { lastErr = e; }

    throw lastErr || new Error('JSON parse failed after 4 repair passes');
}

function parsePacket(packet) {
    const raw = typeof packet === 'string' ? packet : packet?.body;
    const result = robustJsonParse(raw);
    const data = result.data;
    if (!data || typeof data !== 'object') throw new Error('Packet is not an object');
    if (data.schema !== 1 && data.schema !== 2 && data.schema !== 3) throw new Error(`Unsupported schema: ${data.schema}`);
    if (result.recovered) log(`JSON recovered via pass ${result.repairAttempts}`);
    return data;
}

function parseRefreshCharacterBlock(block, fallbackName = '') {
    const text = String(block || '').trim();
    if (!text) return null;
    const activeMatch = text.match(/\[ACTIVE VIR:\s*([^\]]+)\]/i);
    if (activeMatch) {
        const vir = parseActiveVir(text);
        if (Object.keys(vir).length) {
            return { name: activeMatch[1].trim() || fallbackName, vir };
        }
    }
    const lockedMatch = text.match(/\[LOCKED VISUAL CARD:\s*([^\]]+)\]/i);
    if (lockedMatch) {
        const vir = parseCardLines(text);
        if (Object.keys(vir).length) {
            return { name: lockedMatch[1].trim() || fallbackName, vir };
        }
    }
    return null;
}

/**
 * Convert flat schema-3 character object (AI emission) into nested VIR format
 * (lorebook storage). Splits semicolon strings into arrays, builds voice_lock
 * from flat voice_* fields, maps short flat names to canonical VIR field names.
 */
function flatCharToNested(flat) {
    if (!flat || typeof flat !== 'object') return {};
    const vir = { ...flat };
    // outfit/underwear/accessories/equipment: string → array
    const splitSemicolon = (s) => String(s || '').split(/\s*;\s*/).filter(Boolean);
    if (typeof vir.outfit === 'string') vir.outfit = splitSemicolon(vir.outfit);
    if (typeof vir.underwear === 'string') vir.underwear = splitSemicolon(vir.underwear);
    if (typeof vir.accessories === 'string') vir.accessories = splitSemicolon(vir.accessories);
    if (typeof vir.equipment === 'string') vir.equipment = splitSemicolon(vir.equipment);
    // Build voice_lock from flat voice_* fields
    const voice_lock = {};
    if (vir.voice_gender) voice_lock.gender = vir.voice_gender;
    if (vir.voice_vocab) voice_lock.vocab_tier = vir.voice_vocab;
    if (vir.voice_profanity) voice_lock.profanity = vir.voice_profanity;
    if (vir.voice_formality) voice_lock.formality = vir.voice_formality;
    if (vir.voice_signature) voice_lock.signature_phrases = splitSemicolon(vir.voice_signature);
    if (vir.voice_color) voice_lock.dialogue_color = vir.voice_color;
    if (Object.keys(voice_lock).length) vir.voice_lock = voice_lock;
    delete vir.voice_gender; delete vir.voice_vocab; delete vir.voice_profanity;
    delete vir.voice_formality; delete vir.voice_signature; delete vir.voice_color;
    // Map flat short names → canonical VIR field names
    if (vir.age !== undefined && vir.age_appearance === undefined) { vir.age_appearance = vir.age; delete vir.age; }
    if (vir.face !== undefined && vir.face_features === undefined) { vir.face_features = vir.face; delete vir.face; }
    if (vir.brows !== undefined && vir.brow_lash === undefined) { vir.brow_lash = vir.brows; delete vir.brows; }
    if (vir.lips !== undefined && vir.lips_teeth === undefined) { vir.lips_teeth = vir.lips; delete vir.lips; }
    if (vir.skin !== undefined && vir.skin_fur_scales === undefined) { vir.skin_fur_scales = vir.skin; delete vir.skin; }
    if (vir.hands !== undefined && vir.hands_feet === undefined) { vir.hands_feet = vir.hands; delete vir.hands; }
    if (vir.voice !== undefined && vir.posture_voice === undefined) { vir.posture_voice = vir.voice; delete vir.voice; }
    // Strip control fields
    delete vir.action;
    delete vir.name;
    return vir;
}

// ============================================================================
// STRIP LOGIC — fence-aware, RPG-HUD-friendly
// ============================================================================
function stripOrphanSyncBlocks(text) {
    const blocks = findOrphanSyncBlocks(text);
    if (!blocks.length) return text;
    let out = text;
    for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        out = out.slice(0, b.start) + out.slice(b.end);
    }
    return out;
}
// SURGICAL — find each `{...}` JSON object that looks like a VIR packet
// (has 3+ VIR keys) and remove ONLY that object. Walks braces with string/escape
// awareness. Never deletes content outside the matched braces — critical for
// preserving <pic prompt="..."> tags that may follow the JSON in the message.
function stripVirKeyFragments(text) {
    if (!text) return text;
    const KEY_RE = /"(?:schema|characters|new_characters|vir_delta|scene|scene_state|char_state|states|active|active_characters|outfit_layers|hair_state|body_fluids|voice_lock|voice_color|voice_gender|voice_vocab|voice_profanity|dialogue_color|face_features|skin_fur_scales|recall|recall_characters|aftermath|aftermath_marks|geometry|relationships|vad|scene_id|position|injuries)"\s*:/g;
    const masked = maskCodeFences(text); // protect RPG HUD's ```rpg, ```vir already-stripped, etc.
    const removals = []; // { start, end } byte ranges to delete
    // Scan for `{` that opens an object containing 3+ VIR keys; remove that object.
    let i = 0;
    while (i < masked.length) {
        if (masked[i] !== '{') { i++; continue; }
        let depth = 0, inStr = false, escape = false, end = -1;
        for (let j = i; j < masked.length; j++) {
            const ch = masked[j];
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
        }
        if (end === -1) break; // unbalanced — bail, leave message alone
        const blob = masked.slice(i, end);
        // Count VIR keys inside this top-level object. 3+ = VIR packet.
        KEY_RE.lastIndex = 0;
        let keyHits = 0;
        while (KEY_RE.exec(blob) !== null) {
            keyHits++;
            if (keyHits >= 3) break;
        }
        if (keyHits >= 3) {
            removals.push({ start: i, end });
            i = end;
        } else {
            i++;
        }
    }
    if (!removals.length) return text;
    // Apply removals back-to-front so indices stay valid.
    let out = text;
    for (let r = removals.length - 1; r >= 0; r--) {
        out = out.slice(0, removals[r].start) + out.slice(removals[r].end);
    }
    return out.replace(/\n{3,}/g, '\n\n');
}
function stripVirFromMessage(text, processedRaw) {
    let updated = text || '';
    // 1. Exact removal: delete the exact raw blocks we successfully parsed
    for (const raw of processedRaw || []) {
        if (updated.includes(raw)) updated = updated.replace(raw, '');
    }
    // 2. Closed fence removal: delete fully closed ```vir fences
    updated = updated.replace(/```vir\b[\s\S]*?```/gi, '');
    
    // NOTE: Removed the greedy unclosed fence regex (/```vir\b[\s\S]*$/i) because it 
    // inadvertently deletes the <pic> tags placed by st-image-auto-generation.
    
    // 3. Fallback: Orphan block removal
    updated = stripOrphanSyncBlocks(updated);
    updated = stripVirKeyFragments(updated);
    return updated.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * DOM-only strip: remove rendered ```vir code fences, orphan VIR JSON,
 * and bare VIR JSON from the DOM element without touching msg.mes.
 * Matches RPG HUD's stripHudFromDom() approach — safe for async image injection.
 */
const VIR_JSON_SIGNATURE = /"\s*schema\s*"\s*:\s*[123]\s*,\s*"\s*(?:characters|scene|states|new_characters|vir_delta|scene_state)/;
function stripVirFromDom(el) {
    if (!el) return;
    // 1. ST renders ```vir as <pre><code class="language-vir">. Remove those.
    el.querySelectorAll('pre:has(code.language-vir), code.language-vir').forEach(node => {
        const pre = node.closest('pre') || node;
        pre.remove();
    });
    // 2. Also catch VIR JSON in ANY <pre><code> block (AI may omit the vir language tag).
    //    Check text content for the VIR JSON signature.
    el.querySelectorAll('pre > code, pre').forEach(node => {
        const text = node.textContent || '';
        if (VIR_JSON_SIGNATURE.test(text)) {
            const pre = node.closest('pre') || node;
            pre.remove();
        }
    });
    // 3. Remove <vir_sync> XML tags if rendered
    if (/<vir_sync/i.test(el.innerHTML)) {
        el.innerHTML = el.innerHTML.replace(/<vir_sync\b[^>]*>[\s\S]*?<\/vir_sync>/gi, '');
    }
    // 4. Remove bare VIR JSON text that isn't inside a code block.
    //    Walk text nodes, find ones matching VIR JSON signature, remove them.
    if (VIR_JSON_SIGNATURE.test(el.textContent || '')) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const toRemove = [];
        let node;
        while ((node = walker.nextNode())) {
            if (VIR_JSON_SIGNATURE.test(node.textContent || '')) {
                toRemove.push(node);
            }
        }
        for (const n of toRemove) n.parentNode?.removeChild(n);
    }
}

// ============================================================================
// WORLD LIFECYCLE
// ============================================================================
async function ensureWorldLoaded(worldName) {
    let data;
    let loadFailed = false;
    try {
        data = await loadWorldInfo(worldName);
    } catch (err) {
        loadFailed = true;
        warn(`loadWorldInfo failed for "${worldName}":`, err?.message || err);
    }
    if (!data || typeof data !== 'object') {
        // v6 P2-8: surface load failures. Earlier versions silently treated a
        // corrupt or missing lorebook as empty, which then got saved over the
        // existing on-disk file at the next sync, destroying user data.
        if (loadFailed && typeof toastr !== 'undefined') {
            toastr.error(
                `Could not load lorebook "${worldName}". A new empty one will be created. ` +
                'If you had data in this lorebook, restore from a backup before continuing.',
                'FF4 VIR — load failure',
                { timeOut: 8000 },
            );
        }
        data = { entries: {} };
    }
    getEntries(data);
    ensureSchemaEntry(data);        // v6 §3.2: maintain "FF4 VIR Rules" entry
    ensureRecoveryEntry(data);      // v6 §3.2: maintain "FF4 VIR Recovery" entry
    ensureFF4StateEntry(data);      // cleanup obsolete lorebook entry
    cleanupSceneStateEntry(data);   // migrate + cleanup obsolete lorebook entry
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    return data;
}
async function activateCurrentWorld() {
    if (settings().bindToChat) {
        const boundChatLore = chat_metadata?.[WI_METADATA_KEY];
        if (boundChatLore && !isVirWorldName(boundChatLore) && (world_names || []).includes(boundChatLore) && !isUsingMergedChatLore()) {
            const resolution = await resolveChatLoreConflict(boundChatLore);
            if (resolution === 'cancel') {
                clearVirContract();
                updateStatus();
                return;
            }
        }
    }
    const worldName = currentWorldName();
    if (!worldName) return;
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    const nonVirActive = active.filter(n => !isVirWorldName(n));
    const mergedChatLore = isUsingMergedChatLore();
    if (isVirDisabledForChat()) {
        if (active.length !== nonVirActive.length) {
            updateWorldInfoSettings(wiSettings, nonVirActive);
        }
        if (!mergedChatLore && typeof chat_metadata === 'object' && chat_metadata && chat_metadata[WI_METADATA_KEY] === worldName) {
            delete chat_metadata[WI_METADATA_KEY];
            try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
            notifyLoreOperation(`Detached FF4 VIR lorebook "${worldName}" from this chat.`);
        }
        syncChatLorebookUi(mergedChatLore ? (chat_metadata?.[WI_METADATA_KEY] || '') : '');
        clearVirContract();
        updateStatus();
        return;
    }
    const data = await ensureWorldLoaded(worldName);
    rememberWorldChat(worldName);
    // Phase 1 — seed the user persona VIR so {{user}} is tracked too.
    try {
        seedUserPersonaVir(worldName, data);
        rebuildRosterEntry(data);
        await saveWorldInfo(worldName, data, true);
    } catch (e) { warn('user persona seed failed', e); }
    // Chat-bound mode must use chat_metadata only. Putting the VIR world into
    // selected_world_info makes ST treat it as a global lorebook and breaks
    // per-chat attach/detach on chat switches.
    if (settings().bindToChat) {
        if (active.length !== nonVirActive.length) {
            updateWorldInfoSettings(wiSettings, nonVirActive);
        }
        const previousBound = chat_metadata?.[WI_METADATA_KEY];
        if (typeof chat_metadata === 'object' && chat_metadata && chat_metadata[WI_METADATA_KEY] !== worldName) {
            chat_metadata[WI_METADATA_KEY] = worldName;
            try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
        }
        syncChatLorebookUi(worldName);
        if (previousBound !== worldName && isVirWorldName(worldName)) {
            notifyLoreOperation(`Attached FF4 VIR lorebook "${worldName}" to this chat.`);
        }
    } else {
        const nextGlobal = [...nonVirActive, worldName];
        updateWorldInfoSettings(wiSettings, [...new Set(nextGlobal)]);
        if (typeof chat_metadata === 'object' && chat_metadata && chat_metadata[WI_METADATA_KEY] === worldName) {
            delete chat_metadata[WI_METADATA_KEY];
            try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
            notifyLoreOperation(`Detached FF4 VIR lorebook "${worldName}" from this chat.`);
        }
        syncChatLorebookUi('');
    }
    await injectVirContract();
    // v6 — injectVirState() removed. ST owns lorebook injection now.
    updateStatus();
}
async function deleteVirWorld(worldName) {
    if (!isVirWorldName(worldName)) return false;
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    updateWorldInfoSettings(wiSettings, active.filter(n => n !== worldName));
    if (typeof chat_metadata === 'object' && chat_metadata && chat_metadata[WI_METADATA_KEY] === worldName) {
        delete chat_metadata[WI_METADATA_KEY];
        try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
        notifyLoreOperation(`Detached FF4 VIR lorebook "${worldName}" from this chat.`);
    }
    syncChatLorebookUi('');
    const deleted = await deleteWorldInfo(worldName);
    if (deleted) { delete settings().worldChatMap?.[worldName]; saveSettingsDebounced(); }
    return deleted;
}
async function cleanupVirForDeletedChat(chatId) {
    if (!settings().cleanupOnChatDelete || !chatId) return;
    const map = settings().worldChatMap || {};
    const matches = Object.entries(map).filter(([, info]) => info?.chatId === String(chatId)).map(([w]) => w);
    if (!matches.length) return;
    let deleted = 0;
    for (const w of matches) if (await deleteVirWorld(w)) deleted++;
    if (deleted) toastr.info(`Deleted ${deleted} VIR lorebook(s) for removed chat.`, 'FF4 VIR Sync');
    await updateWorldInfoList(); updateStatus();
}

// ============================================================================
// VIR CONTRACT INJECTION (RPG-HUD-style — extension injects its own prompt)
// ============================================================================
// IN_CHAT depth strategy:
//   VIR_CONTRACT (static schema rules) → depth 4, mid-deep reference
//   VIR_STATE    (dynamic per-turn data) → depth 2, fresh per-turn
// Both as role=system so the AI treats them as operating instructions, not
// content. Preset's system block / world info / char description / chat history
// remain untouched — these slot into the chat stream as system messages at the
// chosen depths.
const VIR_CONTRACT_DEPTH = 4;
const VIR_STATE_DEPTH = 2;
// PRIORITY reminder injected at depth 1 — sits between the user's last
// message and the assistant's response, making it the FRESHEST instruction
// the model sees. Content scales with miss count.
const VIR_PRIORITY_DEPTH = 1;
const POSITION_IN_CHAT = 2;

// ── Escalating priority reminder (depth-1 anti-miss) ─────────────────────────
// Three tiers. Default (no misses): a tiny pin so the rule stays fresh.
// After 1 miss: a short escalation. After 2+: a strong warning that quotes
// the miss back at the AI.
function buildPriorityReminder() {
    const st = settings();
    const misses = Math.max(0, st.consecutiveMisses || 0);
    // Always-present anti-deliberation header — bypasses provider's agentic
    // "draft, verify, redraft" training that bloats thinking models like
    // Kimi K2.6. Reasoning stays for STORY content but skips meta-rule-checks.
    const ANTI_AGENT = `[REASONING MODE: single-pass RP, not agent verify-loop. Apply rules silently \xe2\x80\x94 no rule-citation in reasoning, no draft-then-revise.]`;
    if (misses === 0) {
        return `${ANTI_AGENT}
[VIR REMINDER] Include one \`\`\`vir code-fence in the visible reply near the end (after STATS UPDATE; before any other tracker fence like \`\`\`rpg if present). Even an empty delta needs the fence.`;
    }
    if (misses === 1) {
        return `${ANTI_AGENT}
[VIR PRIORITY \xe2\x80\x94 your previous reply did NOT contain a \`\`\`vir block. That is malformed.
Every reply MUST include one \`\`\`vir code-fence in the VISIBLE message (not inside reasoning, not inside <details>). Place it AFTER prose, AFTER pic tags, AFTER STATS UPDATE, and BEFORE any other tracker fence (e.g. \`\`\`rpg). If no other tracker exists, \`\`\`vir is the final block. If \`\`\`rpg or similar tracker exists, it closes the message and \`\`\`vir comes right before it.
Schema: {"schema":3,"characters":[{"name":"...","action":"create|update",<fields>}],"scene":{...}}
If nothing changed for any character, still emit: {"schema":3,"characters":[],"scene":{...}}
[END VIR PRIORITY]`;
    }
    return `${ANTI_AGENT}
[VIR PRIORITY \xe2\x80\x94 CRITICAL: your last ${misses} replies have skipped the \`\`\`vir block. The HUD has no record of recent state changes \xe2\x80\x94 characters are visually drifting because of this.
FIX NOW: this reply MUST include one \`\`\`vir code-fence in the VISIBLE message. NOT in your reasoning. NOT inside <think>. NOT inside <details>. As literal markdown near the bottom of your prose. Place it AFTER prose, AFTER pic tags, AFTER STATS UPDATE, and BEFORE any other tracker fence (e.g. \`\`\`rpg) if one exists. VIR does NOT need absolute-last position when another tracker also requires it \xe2\x80\x94 the other tracker takes the final slot and \`\`\`vir sits immediately before it.
Required schema: {"schema":3,"characters":[{"name":"<who is in scene or whose state changed>","action":"create|update",<at minimum: outfit, pose, expression, condition>}],"scene":{"location":"...","time":"...","active":"<comma-separated names in scene>"}}
A reply that omits \`\`\`vir entirely is MALFORMED and will be rejected.
[END VIR PRIORITY]`;
}

// v6 P2-10: async so callers can await. setExtensionPrompt is sync in current
// ST builds but the signature may become async in future; awaiting both
// future-proofs the call sites and makes priority escalation deterministic
// before the next generation fires.
async function injectVirContract() {
    if (isVirDisabledForChat() || !settings().contractInjection) return;
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        const mode = resolveTemplateMode(getEffectiveTemplate());
        const contract = `${VIR_CONTRACT}

${buildVirBudgetBlock()}

${buildTemplateModeBlock(mode)}`;
        // Main contract at depth 4 (full reference).
        await Promise.resolve(setExtensionPrompt('FF4_VIR_CONTRACT', contract, POSITION_IN_CHAT, VIR_CONTRACT_DEPTH, false, 'system'));
        // Priority reminder at depth 1 — fresh attention anchor. Escalates if AI keeps missing.
        const priority = buildPriorityReminder();
        await Promise.resolve(setExtensionPrompt('FF4_VIR_PRIORITY', priority, POSITION_IN_CHAT, VIR_PRIORITY_DEPTH, false, 'system'));
        // v6: lastInjectionPreview retired — diagnostics panel reads live state.
        log(`VIR contract injected IN_CHAT depth ${VIR_CONTRACT_DEPTH} | priority depth ${VIR_PRIORITY_DEPTH} (misses=${settings().consecutiveMisses||0})`);
    } catch (e) { warn('Contract injection failed', e); }
}
function clearVirContract() {
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        setExtensionPrompt('FF4_VIR_CONTRACT', '', POSITION_IN_CHAT, VIR_CONTRACT_DEPTH);
        // FF4_VIR_STATE slot retired in v6 (kept clear for backwards compat).
        setExtensionPrompt('FF4_VIR_STATE', '', POSITION_IN_CHAT, VIR_STATE_DEPTH);
        setExtensionPrompt('FF4_VIR_PRIORITY', '', POSITION_IN_CHAT, VIR_PRIORITY_DEPTH);
    } catch { /* ignore */ }
}

/**
 * Build the dynamic VIR state context for injection at system-prompt level.
 * Mirrors RPG HUD's buildContext() — formatted, readable summary of the
 * CURRENT world state that the AI references when generating its reply.
 */
// v6 — DELETED: buildVirStateText() and injectVirState().
//
// Earlier versions dumped every VIR entry into a setExtensionPrompt block
// every turn, defeating SillyTavern's native keyword-gated lorebook engine
// (which would inject only entries whose name appears in chat). This made
// `smartTiers` decorative — the data was already in context whether the
// tier flags said to inject or not.
//
// v6 lets SillyTavern own all injection. The extension only writes
// well-formed lorebook entries with correct tier flags (constant / order /
// depth / key[]). ST then handles injection natively:
//   - constant=true  → always inject (PINNED / ACTIVE / RECALL)
//   - constant=false → keyword-gated by entry.key[] (OFFSCREEN — zero
//                      tokens until the character's name appears in chat)
//
// One-time debug preview is now built on demand from the live lorebook,
// see buildLastInjectionPreview() below.

// ============================================================================
// PROCESS SYNC PACKET — apply state to lorebook
// ============================================================================
async function processSyncPacket(sync) {
    if (isVirDisabledForChat()) return { upserted: [], warnings: [] };
    const worldName = currentWorldName();
    if (!worldName) throw new Error('No active chat id');
    const data = await ensureWorldLoaded(worldName);
    const st = settings();
    const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
    const upserted = [];

    // Recall mechanism — schema 3 uses `recall[]`, schema 1/2 uses `recall_characters[]`
    const recallList = Array.isArray(sync.recall) ? sync.recall
                     : Array.isArray(sync.recall_characters) ? sync.recall_characters : [];
    const turns = st.recallTurnsDefault || 8;
    st.recallCharacters = st.recallCharacters || {};
    st.recallCharacters[worldName] = st.recallCharacters[worldName] || {};
    for (const raw of recallList) {
        const name = canonicalizeName(raw).canonical;
        if (name) st.recallCharacters[worldName][name] = turns;
    }
    saveSettingsDebounced();
    const recallActive = new Set(Object.keys(st.recallCharacters[worldName] || {}));

    // ── Extract active character names from packet (no state storage) ──
    const packetActiveNames = new Set();
    // Schema 3: scene.active
    if (sync.scene?.active) {
        const actives = typeof sync.scene.active === 'string'
            ? sync.scene.active.split(/\s*,\s*/).filter(Boolean)
            : Array.isArray(sync.scene.active) ? sync.scene.active : [];
        for (const name of actives) packetActiveNames.add(name);
    }
    // Schema 1/2: scene_state.active_characters
    for (const name of sync.scene_state?.active_characters || []) packetActiveNames.add(name);
    // Cleanup any leftover state lorebook entries
    cleanupSceneStateEntry(data);

    // ── Characters: schema 3 (`characters[]` array) ──
    let skippedNameless = 0;
    if (Array.isArray(sync.characters)) {
        for (const char of sync.characters) {
            if (!char || !char.name) { skippedNameless++; continue; }
            const name = canonicalizeName(char.name).canonical;
            const vir = flatCharToNested(char);
            let entry;
            if (char.action === 'update') {
                entry = applyDelta(data, name, vir);
            } else {
                // "create" or unspecified — treat as new/full character
                entry = upsertCharacter(data, name, { vir });
            }
            if (entry) upserted.push(characterEntryName(entry));
        }
    }
    // Schema 1/2 backward compat: new_characters (object-keyed) + vir_delta (object-keyed)
    for (const [name, payload] of Object.entries(sync.new_characters || {})) {
        const e = upsertCharacter(data, name, payload);
        if (e) upserted.push(characterEntryName(e));
    }
    for (const [name, delta] of Object.entries(sync.vir_delta || {})) {
        const e = applyDelta(data, name, delta);
        if (e) upserted.push(characterEntryName(e));
    }

    // Active char names: from packet scene.active + new chars + recall
    const activeNames = new Set(packetActiveNames);
    if (Array.isArray(sync.characters)) {
        for (const char of sync.characters) {
            if (char?.name && char.action !== 'update') activeNames.add(canonicalizeName(char.name).canonical);
        }
    }
    for (const name of Object.keys(sync.new_characters || {})) activeNames.add(name);
    for (const name of Object.keys(sync.vir_delta || {})) activeNames.add(name);

    // Auto-assign dialogue colors if missing
    assignDialogueColors(data);

    // Apply smart tier flags
    const combinedActive = new Set([...activeNames, ...recallActive]);
    setActiveFlags(data, combinedActive, pinned, recallActive);

    // Rebuild always-on entries
    rebuildRosterEntry(data);
    ensureSchemaEntry(data);        // v6 §3.2: keep rules entry in sync with template-mode changes
    ensureRecoveryEntry(data);      // v6 §3.2: flip recovery entry constant based on miss count
    ensureFF4StateEntry(data);

    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    await activateCurrentWorld();
    // v6 — injectVirState() removed. The lorebook is the single source of
    // truth; ST's native engine handles per-turn injection based on tier
    // flags and keyword matches.

    // Phase 3 — schema-mismatch / empty-packet feedback. If a packet had
    // the schema marker but produced zero usable characters, the AI is
    // emitting a malformed shape — tell the user clearly so they can fix
    // their preset rather than silently getting no tracking.
    const warnings = [];
    if (skippedNameless > 0) {
        warnings.push(`${skippedNameless} character(s) skipped — missing "name" field`);
    }
    const sawCharsKey = Array.isArray(sync.characters) || sync.new_characters || sync.vir_delta;
    if (sawCharsKey && upserted.length === 0) {
        warnings.push('VIR packet parsed but produced 0 characters — check the preset vir schema (flat name-keyed objects, schema 3)');
    }
    return { worldName, upserted: uniqueClean(upserted), warnings };
}

// ============================================================================
// PROCESS MESSAGE — parse VIR packets only (NO strip — that happens in GENERATION_ENDED)
// ============================================================================
async function processMessageData(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message || message.is_user) return [];
    const text = message.mes || '';
    // Skip if no possible VIR content
    if (!text.includes('```vir') && !text.includes('<vir_sync') && !text.includes('"schema"')
        && !text.includes('"characters"') && !text.includes('"vir_delta"')
        && !text.includes('"scene_state"') && !text.includes('"new_characters"')
        && !text.includes('"scene"') && !text.includes('"states"')) return [];

    const packets = extractPackets(text);
    message.extra = message.extra || {};
    message.extra[EXT] = message.extra[EXT] || {};
    const processedHashes = new Set(message.extra[EXT].processed || []);

    const upsertedAll = new Set();
    const allWarnings = [];
    const processedRaw = [];
    let newPackets = 0;

    try {
        for (const packet of packets) {
            const rawHash = hashString(packet.raw);
            if (processedHashes.has(rawHash) || processedHashes.has(packet.sig)) continue;
            let sync;
            try { sync = parsePacket(packet); }
            catch (e) {
                noteSyncStatus(`Packet parse failed: ${e.message}`, [`parse failed: ${e.message}`], true);
                processedHashes.add(rawHash); processedHashes.add(packet.sig);
                processedRaw.push(packet.raw); // Collect raw even on fail for stripping
                continue;
            }
            const result = await processSyncPacket(sync);
            (result.upserted || []).forEach(n => upsertedAll.add(n));
            (result.warnings || []).forEach(w => allWarnings.push(w));
            processedHashes.add(rawHash); processedHashes.add(packet.sig);
            processedRaw.push(packet.raw); // Collect raw for surgical stripping
            sessionPacketCount++;
            newPackets++;
        }
        message.extra[EXT].processed = [...processedHashes];

        if (newPackets || upsertedAll.size) {
            const upNote = upsertedAll.size
                ? ` — tracked: ${[...upsertedAll].join(', ')}`
                : ' — no characters tracked';
            settings().sessionPacketCount = sessionPacketCount;
            noteSyncStatus(`Synced ${newPackets} VIR packet(s)${upNote}`, allWarnings, allWarnings.length > 0);
        }
        return processedRaw;
    } catch (e) {
        error('processMessageData failed', e);
        noteSyncStatus(`VIR sync failed: ${e.message}`, [`failed: ${e.message}`], true);
        return processedRaw;
    }
}

/**
 * GENERATION_ENDED handler — matches RPG HUD's pattern:
 * Find the last AI message, parse VIR data from it, strip msg.mes, save chat.
 * This fires ONCE after the full AI response, so it's safe to modify msg.mes
 * and saveChat() here — ComfyUI image injection happens separately.
 */
async function handleGenerationEnded() {
    if (isVirDisabledForChat()) return;
    const context = getContext();
    if (!context.chat?.length) return;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;

        // Parse VIR data
        let processedRaw = [];
        try { processedRaw = await processMessageData(i) || []; } catch (e) { error('handleGenerationEnded parse:', e); }

        // ── Miss tracking: count consecutive turns with NO parsed vir block.
        //    When AI starts skipping the fence (common after many turns),
        //    escalate the depth-1 priority reminder. Reset on successful parse.
        try {
            const st = settings();
            const sigPresent = !!(msg.extra && msg.extra[EXT] && Array.isArray(msg.extra[EXT].processed) && msg.extra[EXT].processed.length);
            const messageHadAnyVirContent = /```vir|<vir_sync|"schema"\s*:\s*3/.test(msg.mes || '');
            if (processedRaw.length > 0 || sigPresent || messageHadAnyVirContent) {
                if ((st.consecutiveMisses || 0) > 0) {
                    log(`VIR parsed — resetting miss counter (was ${st.consecutiveMisses})`);
                }
                st.consecutiveMisses = 0;
            } else {
                // True miss — AI sent a substantive reply with no vir content at all
                const wordCount = (msg.mes || '').trim().split(/\s+/).length;
                if (wordCount > 40) {
                    // Cap the streak so the escalation stabilises instead of
                    // running away to "your last 905 replies skipped…". Past the
                    // cap the model clearly isn't emitting the fence (often it's
                    // landing in stripped reasoning); screaming a bigger number
                    // only bloats the prompt and makes things worse.
                    const MISS_CAP = 5;
                    st.consecutiveMisses = Math.min(MISS_CAP, (st.consecutiveMisses || 0) + 1);
                    st.totalMisses = (st.totalMisses || 0) + 1;
                    warn(`VIR miss #${st.consecutiveMisses} (cap ${MISS_CAP}, total ${st.totalMisses}) — escalating depth-1 reminder`);
                }
            }
            saveSettingsDebounced();
            // Re-inject contract + escalated priority for the NEXT turn
            await injectVirContract();
        } catch (e) { warn('miss tracking failed:', e); }

        // Fetch fresh mes! Another extension (like st-image-auto-generation) might
        // have modified msg.mes during the await above. Using a stale string here
        // would overwrite and erase their changes.
        const currentMes = msg.mes || '';

        // Strip VIR blocks from msg.mes
        if (settings().autoHideSyncedPackets) {
            const cleaned = stripVirFromMessage(currentMes, processedRaw);
            if (cleaned !== currentMes) {
                msg.mes = cleaned;
                try { context.saveChat(); } catch (e) { warn('saveChat failed:', e); }
                // Also strip from DOM if already rendered
                const domEl = document.querySelector(`.mes[mesid="${i}"] .mes_text`);
                if (domEl) stripVirFromDom(domEl);
            }
        }

        // Decay recall counters
        try { await decayRecall(); } catch (e) { error('recall decay:', e); }
        break;
    }
}

/**
 * MESSAGE_RECEIVED handler — DOM-only strip (matches RPG HUD).
 * Never touches msg.mes — that's handled by GENERATION_ENDED.
 */
function handleMessageReceived(mesId) {
    if (isVirDisabledForChat()) return;
    const context = getContext();
    const idx = typeof mesId === 'number' ? mesId : context.chat.length - 1;
    const msg = context.chat?.[idx];
    if (!msg || msg.is_user) return;
    const el = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
    if (el) stripVirFromDom(el);
}

/**
 * CHARACTER_MESSAGE_RENDERED handler — DOM-only strip after render.
 * Catches any VIR fences that survived into rendered HTML.
 */
function handleMessageRendered(mesId) {
    if (isVirDisabledForChat()) return;
    const context = getContext();
    const idx = typeof mesId === 'number' ? mesId : context.chat.length - 1;
    const el = document.querySelector(`.mes[mesid="${idx}"] .mes_text`);
    if (el) stripVirFromDom(el);
}

// ============================================================================
// RECALL DECAY
// ============================================================================
async function decayRecall() {
    const worldName = currentWorldName();
    if (!worldName) return;
    const st = settings();
    const recall = st.recallCharacters?.[worldName];
    if (!recall || !Object.keys(recall).length) return;
    let expired = false;
    let tickedDown = false;
    for (const name of Object.keys(recall)) {
        recall[name]--;
        tickedDown = true;
        if (recall[name] <= 0) { delete recall[name]; expired = true; }
    }
    // P0-2 FIX: always persist when ANY recall counter ticked down, not only
    // when an entry expired. Previously decremented values stayed in memory
    // until the entry hit zero, so a page reload could reset the counter back
    // to its pre-decay value, and the constant-injected character pool grew
    // unboundedly over long sessions.
    if (tickedDown) saveSettingsDebounced();
    if (expired) {
        const data = await loadWorldInfo(worldName);
        if (data) {
            const activeNames = new Set();
            const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
            const recallSet = new Set(Object.keys(recall));
            setActiveFlags(data, activeNames, pinned, recallSet);
            ensureFF4StateEntry(data);
            await saveWorldInfo(worldName, data, true);
        }
    }
}

// ============================================================================
// SLASH COMMANDS (minimal — 5 essentials)
// ============================================================================
// ============================================================================
// v5.5 — VIR utility commands (show / export / import / archive / restore)
// ============================================================================
const ARCHIVES_WORLD = 'FF4 VIR - Archives';

async function loadArchivesWorld() {
    let data = await loadWorldInfo(ARCHIVES_WORLD).catch(() => null);
    if (!data) {
        data = { entries: {} };
        await saveWorldInfo(ARCHIVES_WORLD, data);
        // Make sure ST sees the new world in its registry
        try { await updateWorldInfoList?.(); } catch { /* ignore */ }
    }
    return data;
}

function printToChat(message) {
    // Fall through to console if we can't post to chat — never throw.
    try {
        const ctx = getContext();
        ctx?.sendSystemMessage
            ? ctx.sendSystemMessage('generic', String(message || ''))
            : console.log(`[${EXT}]`, message);
    } catch (err) {
        console.log(`[${EXT}]`, message, err?.message);
    }
}

async function virshowCmd(args, value) {
    const name = String(value || '').trim();
    if (!name) return 'Usage: /virshow <Name>';
    const worldName = currentWorldName();
    if (!worldName) return 'No active chat.';
    const data = await loadWorldInfo(worldName);
    const entry = data ? findCharacterEntry(data, name) : null;
    if (!entry) return `No VIR entry found for "${name}". Try /vir-list to see active names.`;
    const vir = parseActiveVir(entry.content || '');
    const lines = [`**VIR entry — ${characterEntryName(entry)}**`];
    const printable = (k, v) => v ? lines.push(`- ${k}: ${Array.isArray(v) ? v.join('; ') : v}`) : null;
    printable('full_name', vir.full_name);
    printable('source', vir.source);
    printable('species', vir.species);
    printable('age_appearance', vir.age_appearance);
    printable('height', vir.height);
    printable('build', vir.build);
    printable('body', vir.body);
    printable('body_material', vir.body_material);
    printable('hair', vir.hair);
    printable('hair_state', vir.hair_state);
    printable('eyes', vir.eyes);
    printable('skin/fur/scales', vir.skin_fur_scales);
    printable('face_features', vir.face_features);
    printable('marks', vir.marks);
    printable('non_human', vir.non_human);
    printable('outfit', vir.outfit);
    printable('underwear', vir.underwear);
    printable('accessories', vir.accessories);
    printable('equipment', vir.equipment);
    printable('pose', vir.pose);
    printable('expression', vir.expression);
    printable('condition', vir.condition);
    printable('location_context', vir.location_context);
    if (vir.voice_lock?.dialogue_color) lines.push(`- dialogue_color: ${vir.voice_lock.dialogue_color}`);
    printToChat(lines.join('\n'));
    return '';
}

async function virexportCmd() {
    const worldName = currentWorldName();
    if (!worldName) return 'No active chat.';
    const data = await loadWorldInfo(worldName);
    if (!data) return 'No lorebook for current chat.';
    const payload = { world: worldName, exportedAt: new Date().toISOString(), version: VERSION, entries: data.entries || {} };
    const json = JSON.stringify(payload, null, 2);
    try {
        await navigator.clipboard.writeText(json);
        const count = Object.keys(payload.entries).length;
        return `Copied ${count} entr${count === 1 ? 'y' : 'ies'} to clipboard (world: ${worldName}).`;
    } catch (err) {
        console.log(`[${EXT}] /virexport JSON:`, json);
        return `Clipboard unavailable; full JSON printed to browser console. Error: ${err?.message || err}`;
    }
}

async function virimportCmd(args, value) {
    let raw = String(value || '').trim();
    if (!raw) {
        try { raw = (await navigator.clipboard.readText()).trim(); } catch { /* ignore */ }
    }
    if (!raw) return 'Usage: /virimport <json>  (or copy JSON to clipboard then run /virimport)';
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { return `JSON parse error: ${err.message}`; }
    if (!parsed || typeof parsed !== 'object') return 'Imported value must be an object.';
    const importedEntries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : parsed;
    if (typeof importedEntries !== 'object') return 'No "entries" object found in imported JSON.';
    const worldName = currentWorldName();
    if (!worldName) return 'No active chat.';
    const data = await loadWorldInfo(worldName) || { entries: {} };
    const target = getEntries(data);
    let added = 0, updated = 0;
    for (const imported of Object.values(importedEntries)) {
        if (!imported || typeof imported !== 'object') continue;
        const importedName = String(imported.comment || '').replace(/^VIR:\s*/i, '').trim();
        if (!importedName) continue;
        const existing = findCharacterEntry(data, importedName);
        if (existing) {
            Object.assign(existing, imported, { uid: existing.uid });   // keep existing UID
            updated++;
        } else {
            const uid = nextUid(data);
            target[uid] = { ...imported, uid };
            added++;
        }
    }
    await saveWorldInfo(worldName, data);
    return `Imported into ${worldName}: ${added} new, ${updated} updated.`;
}

async function virarchiveCmd(args, value) {
    const name = String(value || '').trim();
    if (!name) return 'Usage: /virarchive <Name>';
    const worldName = currentWorldName();
    if (!worldName) return 'No active chat.';
    const data = await loadWorldInfo(worldName);
    const entry = data ? findCharacterEntry(data, name) : null;
    if (!entry) return `No VIR entry to archive for "${name}".`;
    const archive = await loadArchivesWorld();
    const archiveEntries = getEntries(archive);
    const canonical = characterEntryName(entry);
    const existing = findCharacterEntry(archive, canonical);
    if (existing) {
        Object.assign(existing, entry, { uid: existing.uid });
    } else {
        const uid = nextUid(archive);
        archiveEntries[uid] = { ...entry, uid };
    }
    await saveWorldInfo(ARCHIVES_WORLD, archive);
    return `Archived "${canonical}" → ${ARCHIVES_WORLD}.`;
}

async function vircolorsCmd(args, value) {
    const st = settings();
    const arg = String(value || '').trim().toLowerCase();
    if (arg === 'on') st.dialogueColorEnabled = true;
    else if (arg === 'off') st.dialogueColorEnabled = false;
    else st.dialogueColorEnabled = !st.dialogueColorEnabled;
    saveSettingsDebounced();
    if (st.dialogueColorEnabled) {
        applyDialogueColors();
        return 'Dialogue colours ENABLED. Each VIR character\'s .name_text is now coloured per voice_lock.dialogue_color.';
    }
    // Strip colours from currently-rendered messages
    try { document.querySelectorAll('#chat .mes .name_text').forEach(n => n.style.removeProperty('color')); } catch { /* ignore */ }
    return 'Dialogue colours DISABLED.';
}

async function virrestoreCmd(args, value) {
    const name = String(value || '').trim();
    if (!name) return 'Usage: /virrestore <Name>';
    const worldName = currentWorldName();
    if (!worldName) return 'No active chat.';
    const archive = await loadArchivesWorld();
    const source = findCharacterEntry(archive, name);
    if (!source) return `No archived character matching "${name}". Use /virarchive first.`;
    const data = await loadWorldInfo(worldName) || { entries: {} };
    const target = getEntries(data);
    const canonical = characterEntryName(source);
    const existing = findCharacterEntry(data, canonical);
    if (existing) {
        Object.assign(existing, source, { uid: existing.uid });
    } else {
        const uid = nextUid(data);
        target[uid] = { ...source, uid };
    }
    await saveWorldInfo(worldName, data);
    await reapplyTiers();
    return `Restored "${canonical}" from archive into ${worldName}.`;
}

// ============================================================================
// v5.5 — image-anchor anti-drift check
// ============================================================================
// When applyDelta merges new VIR data over an existing entry, compare stable
// identity fields. If a stable field changed without an explicit story event,
// log a warning. Diagnostic only — does NOT block the change.
const ANTI_DRIFT_STABLE_FIELDS = ['species', 'age_appearance', 'height', 'hair', 'eyes', 'skin_fur_scales', 'body_material', 'non_human'];

function checkVirDrift(name, oldVir, newDelta) {
    if (!settings().enabled) return;
    if (!oldVir || typeof oldVir !== 'object') return;
    const changed = [];
    for (const field of ANTI_DRIFT_STABLE_FIELDS) {
        const oldV = String(oldVir[field] || '').trim();
        const newV = String(newDelta?.[field] || '').trim();
        if (newV && oldV && oldV !== newV) changed.push(`${field}: "${oldV}" → "${newV}"`);
    }
    if (changed.length) {
        warn(`Image-anchor drift for "${name}":\n  ${changed.join('\n  ')}\n  Stable fields normally never change; ensure the story event justifies this.`);
    }
}

async function registerSlashCommands() {
    try {
        const mod = await import('../../../slash-commands.js');
        const slashCmdMod = await import('../../../slash-commands/SlashCommand.js');
        const parser = mod.SlashCommandParser?.commands ? mod.SlashCommandParser : null;
        const SlashCommand = slashCmdMod.SlashCommand;
        if (!parser) return;
        const reg = (name, callback, helpText) => {
            try {
                if (parser.addCommandObject && SlashCommand?.fromProps) {
                    parser.addCommandObject(SlashCommand.fromProps({
                        name,
                        callback,
                        helpString: helpText,
                    }));
                    return;
                }
                if (parser.addCommand) {
                    parser.addCommand(name, callback, [], helpText);
                    return;
                }
            } catch {
                if (typeof window.registerSlashCommand === 'function') {
                    window.registerSlashCommand(name, callback, [], helpText, true, true);
                }
            }
        };
        const recall = async (args, value) => {
            const name = String(value || '').trim();
            if (!name) return 'Usage: /vir-recall <Name>';
            const worldName = currentWorldName();
            if (!worldName) return 'No active chat.';
            const canonical = canonicalizeName(name).canonical;
            const turns = parseInt(args?.turns) || settings().recallTurnsDefault || 8;
            const st = settings();
            st.recallCharacters = st.recallCharacters || {};
            st.recallCharacters[worldName] = st.recallCharacters[worldName] || {};
            st.recallCharacters[worldName][canonical] = turns;
            saveSettingsDebounced();
            await reapplyTiers();
            return `Recalled ${canonical} for ${turns} turns.`;
        };
        const pin = async (args, value) => {
            const name = String(value || '').trim();
            if (!name) return 'Usage: /vir-pin <Name>';
            const worldName = currentWorldName();
            if (!worldName) return 'No active chat.';
            const canonical = canonicalizeName(name).canonical;
            pinCharacter(worldName, canonical);
            await reapplyTiers();
            return `Pinned ${canonical} (Tier A, always active).`;
        };
        const park = async (args, value) => {
            const name = String(value || '').trim();
            if (!name) return 'Usage: /vir-park <Name>';
            const worldName = currentWorldName();
            if (!worldName) return 'No active chat.';
            const canonical = canonicalizeName(name).canonical;
            unpinCharacter(worldName, canonical);
            const st = settings();
            if (st.recallCharacters?.[worldName]) {
                delete st.recallCharacters[worldName][canonical];
                saveSettingsDebounced();
            }
            await reapplyTiers();
            return `Parked ${canonical} (offscreen, keyword-only).`;
        };
        const list = async () => {
            const worldName = currentWorldName();
            if (!worldName) return 'No active chat.';
            const data = await loadWorldInfo(worldName);
            if (!data) return 'No lorebook.';
            const chars = characterEntries(data);
            if (!chars.length) return 'No characters registered.';
            const st = settings();
            const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
            const recall = st.recallCharacters?.[worldName] || {};
            const lines = [`VIR Characters (${chars.length}):`];
            for (const [, entry] of chars) {
                const name = characterEntryName(entry);
                const tier = getCharacterTierInfo(entry, name, pinned, recall).tier;
                lines.push(`  [${tier}] ${name}`);
            }
            return lines.join('\n');
        };
        const status = async () => {
            const worldName = currentWorldName();
            const st = settings();
            const chatOverrides = getChatOverrides();
            const lines = [
                `FF4 VIR v${VERSION}`,
                `Enabled: ${st.enabled}`,
                `Disabled for this chat: ${chatOverrides.disabled}`,
                `Smart tiers: ${st.smartTiers !== false}`,
                `Contract injection: ${st.contractInjection !== false}`,
                `Template: ${getEffectiveTemplate()}${chatOverrides.templateMode ? ` (chat override; global ${st.templateMode || 'Detailed'})` : ` (global ${st.templateMode || 'Detailed'})`}`,
                `Current world: ${worldName || 'none'}`,
                `Session packets: ${sessionPacketCount}`,
                `Last sync: ${st.lastSyncStatus}`,
            ];
            return lines.join('\n');
        };
        const parseTemplateScope = (rawArgs, rawValue) => {
            const args = rawArgs || {};
            const source = String(rawValue || '');
            const globalFlag = args.global === true || args.global === 'true' || /\s--global\b/i.test(source) || /^--global\b/i.test(source);
            const cleaned = source.replace(/\s--global\b/ig, '').replace(/^--global\b\s*/i, '').trim();
            return { globalFlag, target: cleaned };
        };
        const sheetDirective = (kind, rawName) => {
            const name = canonicalizeName(String(rawName || '').trim()).canonical;
            if (!name) return `Usage: /vir${kind} <Name>`;
            const mode = settings().sheetCommandMode || getEffectiveTemplate();
            const common = `OOC: Pause the RP for one response and run a VIR ${kind.toUpperCase()} for ${name}. End with exactly one \`\`\`vir block using schema 3 so FF4 VIR Sync can ingest it.`;
            if (kind === 'quick') {
                return `${common} Emit a compact visual-only update/create for ${name}: full_name, source, species, age_appearance, height, build, hair, eyes, skin_fur_scales, face_features, body, marks, outfit, accessories, pose, expression, condition, location_context. Keep values short and image-friendly.`;
            }
            if (kind === 'repair') {
                return `${common} Repair missing or weak visual fields for ${name}. Prioritize full_name, full source/show/game/VN name or "original character", outfit pieces, marks, accessories, current pose/expression/condition, and PIC_COPY consistency. Do not invent a source if unknown.`;
            }
            if (kind === 'detail') {
                return `${common} ENRICH every visual field for ${name} with micro-anchors so the same pic prompt renders the same way every time. For each piece of outfit/underwear/accessories: colour shade + material + item type + cut/sleeve/neckline + fit + length + closure + distinguishing detail. For hair: shade + length to a body landmark + texture + styling + parting + fringe + distinguishing detail. For eyes: shade + secondary tone + shape + size + lash + distinguishing detail. For marks: type + size + exact placement relative to an anatomical landmark + colour + healing state. For footwear: height + closure with eyelet count if laced + heel type + toe shape. Replace any field value that has fewer than 6 concrete anchors. Preserve story-established facts; do not change what colour/style something WAS, only add detail. Output a single update packet containing only the enriched fields.`;
            }
            return `${common} Mode: ${mode}. Create or update a full identity sheet for ${name}: stable identity, full source, body, face, marks, clothing layers, accessories, equipment, pose, expression, condition, and location context. Preserve existing stable fields unless story evidence changed them.`;
        };
        reg('vir-recall', recall, 'Recall a character for N turns. Usage: /vir-recall <Name>');
        reg('vir-pin',    pin,    'Pin a character to Tier A (always active). Usage: /vir-pin <Name>');
        reg('vir-park',   park,   'Unpin/clear recall. Usage: /vir-park <Name>');
        reg('vir-list',   list,   'List all VIR characters with their tier.');
        reg('vir-status', status, 'Show FF4 VIR extension status.');
        reg('vir-template', async (args, value) => {
            const { globalFlag, target } = parseTemplateScope(args, value);
            if (!target) {
                const overrides = getChatOverrides();
                const scope = overrides.templateMode ? `chat override ${overrides.templateMode}` : 'no chat override';
                return `Current template: ${getEffectiveTemplate()} (${scope}; global ${settings().templateMode || 'Detailed'}). Usage: /vir-template <Compact|Standard|Detailed> [--global]`;
            }
            const valid = ['Compact', 'Standard', 'Detailed'];
            const match = valid.find(v => v.toLowerCase() === target.toLowerCase());
            if (!match) return `Invalid template "${target}". Choose: ${valid.join(' | ')}`;
            if (globalFlag || !getCurrentChatId()) {
                settings().templateMode = match;
                saveSettingsDebounced();
            } else {
                await setChatOverrides({ ...getChatOverrides(), templateMode: match });
            }
            const select = document.getElementById('ff4_vir_template_mode');
            if (select && globalFlag) select.value = match;
            await activateCurrentWorld();
            renderCharacterList();
            return globalFlag || !getCurrentChatId()
                ? `Global template switched to ${match} (<=${resolveTemplateMode(match).budgetTokens} tok/char).`
                : `Template override for this chat set to ${match} (<=${resolveTemplateMode(match).budgetTokens} tok/char). Existing entries keep their old shape until refreshed.`;
        }, 'Switch VIR template for this chat, or use --global for the global default. Usage: /vir-template <Compact|Standard|Detailed> [--global]');
        reg('vir-disable', async () => {
            if (!getCurrentChatId()) return 'No active chat.';
            await setChatOverrides({ ...getChatOverrides(), disabled: true });
            await activateCurrentWorld();
            return 'FF4 VIR disabled for this chat.';
        }, 'Disable FF4 VIR for the current chat.');
        reg('vir-enable', async () => {
            if (!getCurrentChatId()) return 'No active chat.';
            await setChatOverrides({ ...getChatOverrides(), disabled: false });
            await activateCurrentWorld();
            return 'FF4 VIR enabled for this chat.';
        }, 'Enable FF4 VIR for the current chat.');
        reg('virsheet', async (args, value) => sheetDirective('sheet', value), 'Ask AI for a full VIR identity sheet. Usage: /virsheet <Name>');
        reg('virquick', async (args, value) => sheetDirective('quick', value), 'Ask AI for a compact visual VIR sheet. Usage: /virquick <Name>');
        reg('virrepair', async (args, value) => sheetDirective('repair', value), 'Ask AI to repair weak/missing VIR fields. Usage: /virrepair <Name>');
        reg('virdetail', async (args, value) => sheetDirective('detail', value), 'Ask AI to enrich every VIR field with micro-anchors (6-10 per field) to lock pic-to-pic consistency. Usage: /virdetail <Name>');
        // v5.5 — virshow / virexport / virimport / virarchive / virrestore
        reg('virshow',    virshowCmd,    'Show stored VIR fields for a character. Usage: /virshow <Name>');
        reg('virexport',  virexportCmd,  'Copy current chat\'s VIR world to clipboard as JSON. Usage: /virexport');
        reg('virimport',  virimportCmd,  'Import JSON into current chat\'s VIR world. Usage: /virimport <json>  (or paste then /virimport)');
        reg('virarchive', virarchiveCmd, 'Copy a VIR entry to the global archive world. Usage: /virarchive <Name>');
        reg('virrestore', virrestoreCmd, 'Restore a character from the archive into this chat. Usage: /virrestore <Name>');
        reg('vircolors',  vircolorsCmd, 'Toggle dialogue colour CSS. Usage: /vircolors  (or  /vircolors on / off)');
        log('Slash commands registered');
    } catch (e) {
        warn('Slash command registration failed', e);
    }
}

async function reapplyTiers() {
    const worldName = currentWorldName();
    if (!worldName) return;
    const data = await loadWorldInfo(worldName);
    if (!data) return;
    const st = settings();
    const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
    const recall = new Set(Object.keys(st.recallCharacters?.[worldName] || {}));
    // No stored scene state — active set is empty; tiers set during last sync remain.
    // Pinned/recall overrides are still applied.
    setActiveFlags(data, new Set(), pinned, recall);
    ensureFF4StateEntry(data);
    rebuildRosterEntry(data);
    ensureSchemaEntry(data);        // v6 §3.2
    ensureRecoveryEntry(data);      // v6 §3.2
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
}

// ============================================================================
// UI
// ============================================================================
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function $(id) { return document.getElementById(id); }

async function buildDiagnosticsSnapshot() {
    const worldName = currentWorldName();
    const st = settings();
    const chatOverrides = getChatOverrides();
    const snapshot = {
        version: VERSION,
        chatId: getCurrentChatId?.() || '',
        worldName,
        enabled: !!st.enabled,
        chatDisabled: chatOverrides.disabled,
        chatTemplateOverride: chatOverrides.templateMode || '',
        contractInjection: st.contractInjection !== false,
        templateMode: getEffectiveTemplate(),
        depths: { contract: VIR_CONTRACT_DEPTH, state: VIR_STATE_DEPTH, priority: VIR_PRIORITY_DEPTH },
        missStreak: st.consecutiveMisses || 0,
        totalMisses: st.totalMisses || 0,
        sessionPackets: sessionPacketCount,
        lastSyncStatus: st.lastSyncStatus || 'No sync yet',
        recentWarnings: st.recentWarnings || [],
        tokenEstimate: 0,
        characters: [],
    };
    if (!worldName) return snapshot;
    try {
        const data = await loadWorldInfo(worldName);
        if (!data) return snapshot;
        const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
        const recall = st.recallCharacters?.[worldName] || {};
        let totalChars = 0;
        for (const [, entry] of characterEntries(data)) {
            const name = characterEntryName(entry);
            if (!name) continue;
            const constant = entry.constant !== false && !entry.disable;
            if (constant) totalChars += String(entry.content || '').length;
            const tierInfo = getCharacterTierInfo(entry, name, pinned, recall);
            snapshot.characters.push({
                name,
                tier: tierInfo.tier.replace(/\d+$/, ''),
                reason: constant && isUserVirEntry(entry) ? `${tierInfo.reason}; user entry constant` : tierInfo.reason,
                order: entry.order,
                depth: entry.depth,
                constant,
                disabled: !!entry.disable,
            });
        }
        snapshot.tokenEstimate = Math.round(totalChars / 3.8);
    } catch (e) {
        snapshot.recentWarnings = [`Diagnostics failed: ${e.message}`, ...snapshot.recentWarnings].slice(0, MAX_RECENT_WARNINGS);
    }
    return snapshot;
}

async function copyVirDebugReport() {
    const report = await buildDiagnosticsSnapshot();
    const text = JSON.stringify(report, null, 2);
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('VIR debug report copied.', 'FF4 VIR');
    } catch {
        console.log(`[${EXT}] debug report`, report);
        toastr.warning('Clipboard unavailable; report printed to console.', 'FF4 VIR');
    }
}

window.ff4VirGetPicCopies = async function ff4VirGetPicCopies(names = []) {
    const worldName = currentWorldName();
    if (!worldName) return {};
    const wanted = new Set((Array.isArray(names) ? names : String(names || '').split(','))
        .map(n => canonicalizeName(String(n || '').trim()).canonical.toLowerCase())
        .filter(Boolean));
    try {
        const data = await loadWorldInfo(worldName);
        if (!data) return {};
        const st = settings();
        const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
        const recall = st.recallCharacters?.[worldName] || {};
        const out = {};
        for (const [, entry] of characterEntries(data)) {
            const name = characterEntryName(entry);
            if (!name) continue;
            if (wanted.size && !wanted.has(name.toLowerCase())) continue;
            const vir = parseActiveVir(entry.content || '');
            const constant = entry.constant !== false && !entry.disable;
            const tier = getCharacterTierInfo(entry, name, pinned, recall).tier.replace(/\d+$/, '');
            out[name] = {
                name,
                tier,
                constant,
                pic_identity: buildPicIdentity(name, vir) || name,
                pic_copy: buildPicParagraph(name, vir) || extractPicCopy(entry.content || ''),
                source: canonicalSourceName(vir),
            };
        }
        return out;
    } catch (e) {
        warn('ff4VirGetPicCopies failed', e);
        return {};
    }
};

function renderSettings() {
    if ($('ff4_vir_settings')) return;
    $('extensions_settings')?.insertAdjacentHTML('beforeend', `
        <div id="ff4_vir_settings" class="ff4-vir-panel">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>FF4 VIR Lorebook Sync</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ff4-vir-subtitle">v${VERSION} — Dynamic character tracking · Auto-injected contract</div>

                    <label class="ff4-vir-tog" title="Master toggle. Disabling stops all extension activity."><input id="ff4_vir_enabled" type="checkbox"> <span>Enabled</span></label>
                    <label class="ff4-vir-tog" title="Smart tiers: character VIR entries stay keyword-triggered, but their order/depth follows pinned, active, and recall state. The seeded {{user}} entry may stay constant."><input id="ff4_vir_smart_tiers" type="checkbox"> <span>Smart dynamic tiers (recommended)</span></label>
                    <label class="ff4-vir-tog" title="Strip the AI's emitted vir packet from the visible chat so prose stays clean."><input id="ff4_vir_auto_hide" type="checkbox"> <span>Auto-hide synced packets</span></label>
                    <label class="ff4-vir-tog" title="Inject the VIR contract + current world state into every generation. Like RPG HUD — no preset edit needed."><input id="ff4_vir_contract" type="checkbox"> <span>Auto-inject contract + state</span></label>

                    <label class="ff4-vir-tog" title="Auto-create a pinned VIR entry from your active persona description so {{user}} is tracked alongside NPCs. The AI never emits a vir packet for the user — this bridges that gap."><input id="ff4_vir_seed_user" type="checkbox"> <span>Track user persona ({{user}})</span></label>

                    <div class="ff4-vir-mode-row">
                        <label for="ff4_vir_template_mode"><b>Template mode</b></label>
                        <select id="ff4_vir_template_mode" class="text_pole widthNatural">
                            <option value="Compact">Compact (≤128 tok)</option>
                            <option value="Standard">Standard (≤192 tok)</option>
                            <option value="Detailed">Detailed (≤256 tok)</option>
                        </select>
                        <span class="ff4-vir-muted ff4-vir-mode-hint">Existing entries keep their old format until you click 🔄 on each row.</span>
                    </div>

                    <details class="ff4-vir-advanced">
                        <summary>Per-chat overrides</summary>
                        <label class="ff4-vir-tog" title="Disable FF4 VIR for only this chat. The lorebook stays on disk; parsing, activation, and contract injection are skipped until you re-enable it."><input id="ff4_vir_chat_disabled" type="checkbox"> <span>Disable FF4 VIR in this chat</span></label>
                        <div class="ff4-vir-mode-row">
                            <label for="ff4_vir_chat_template_mode"><b>Chat template override</b></label>
                            <select id="ff4_vir_chat_template_mode" class="text_pole widthNatural">
                                <option value="">Use global template</option>
                                <option value="Compact">Compact (<=128 tok)</option>
                                <option value="Standard">Standard (<=192 tok)</option>
                                <option value="Detailed">Detailed (<=256 tok)</option>
                            </select>
                            <span id="ff4_vir_chat_template_hint" class="ff4-vir-muted ff4-vir-mode-hint">Uses the global template by default.</span>
                        </div>
                    </details>

                    <details class="ff4-vir-advanced">
                        <summary>Advanced</summary>
                        <label class="ff4-vir-tog" title="Show injection diagnostics and copyable debug reports."><input id="ff4_vir_diagnostics" type="checkbox"> <span>Diagnostics panel</span></label>
                        <label class="ff4-vir-tog" title="Store the VIR lorebook reference in chat metadata so it re-activates automatically when you reopen this chat."><input id="ff4_vir_bind_to_chat" type="checkbox"> <span>Bind lorebook to current chat</span></label>
                        <label class="ff4-vir-tog" title="When a chat is deleted, also delete its VIR lorebook so orphaned lorebooks don't pile up."><input id="ff4_vir_cleanup_delete" type="checkbox"> <span>Delete VIR lorebook when chat deleted</span></label>
                        <label class="ff4-vir-tog" title="Verbose console logging + toasts for troubleshooting."><input id="ff4_vir_debug" type="checkbox"> <span>Debug logging</span></label>
                        <div class="ff4-vir-slider-row" title="How many recent chat messages to send to the AI during a 🔄 Refresh. Lower = cheaper, less informed. Higher = more accurate state updates.">
                            <label for="ff4_vir_refresh_turns">Refresh context (chat tail):</label>
                            <input id="ff4_vir_refresh_turns" type="range" min="0" max="50" step="5" value="20">
                            <span id="ff4_vir_refresh_turns_val">20</span>
                            <span class="ff4-vir-muted">msgs</span>
                        </div>
                        <div class="ff4-vir-slider-row" title="Cooldown after a successful 🔄 Refresh before the same character can be refreshed again. Prevents click-spam.">
                            <label for="ff4_vir_refresh_cooldown">Refresh cooldown:</label>
                            <input id="ff4_vir_refresh_cooldown" type="range" min="0" max="120" step="10" value="30">
                            <span id="ff4_vir_refresh_cooldown_val">30</span>
                            <span class="ff4-vir-muted">s</span>
                        </div>
                    </details>

                    <div class="ff4-vir-status">
                        <div><b>World:</b> <span id="ff4_vir_current_world">--</span></div>
                        <div><b>Bound:</b> <span id="ff4_vir_bound">--</span> · <b>Chars:</b> <span id="ff4_vir_char_count">0</span> · <b>Session:</b> <span id="ff4_vir_session_count">0</span></div>
                        <div><b>Tokens:</b> <span id="ff4_vir_token_estimate">--</span></div>
                        <div><b>Last:</b> <span id="ff4_vir_last_sync" class="ff4-vir-muted">No sync yet</span></div>
                    </div>

                    <details class="ff4-vir-chars" open>
                        <summary>Characters <span class="ff4-vir-muted ff4-vir-tier-legend">PIN · ACT · RCL · OFF</span></summary>
                        <div id="ff4_vir_char_list" class="ff4-vir-char-list"><div class="ff4-vir-muted">Loading...</div></div>
                    </details>

                    <details class="ff4-vir-warnings">
                        <summary>Recent warnings (<span id="ff4_vir_warn_count">0</span>)</summary>
                        <div id="ff4_vir_warnings"></div>
                    </details>

                    <details class="ff4-vir-diagnostics">
                        <summary>Diagnostics</summary>
                        <div id="ff4_vir_diagnostics_body" class="ff4-vir-muted">Loading...</div>
                    </details>

                    <div class="ff4-vir-buttons">
                        <button id="ff4_vir_activate" class="menu_button" title="Force re-activate VIR lorebook in ST's Active Worlds list">⚓ Activate</button>
                        <button id="ff4_vir_refresh" class="menu_button">⟳ Refresh UI</button>
                        <button id="ff4_vir_batch_refresh" class="menu_button" title="Re-run AI on EVERY character to update them all to the current template. One generation per character. Confirm before proceeding.">🔄 Refresh all chars</button>
                        <button id="ff4_vir_remind" class="menu_button" title="Force the next AI generation to be reminded of the VIR contract at maximum priority (depth 1, escalated). Useful when the AI starts skipping vir packets.">🔔 Remind AI</button>
                        <button id="ff4_vir_copy_debug" class="menu_button">Copy Debug</button>
                        <button id="ff4_vir_clear_warn" class="menu_button">Clear</button>
                        <button id="ff4_vir_export" class="menu_button">⬇ Export</button>
                        <label for="ff4_vir_import" class="menu_button">⬆ Import</label>
                        <input id="ff4_vir_import" type="file" accept="application/json" style="display:none">
                        <button id="ff4_vir_reset_settings" class="menu_button" title="Reset all extension settings to their factory defaults (does NOT touch the lorebook).">⚙ Reset settings</button>
                        <button id="ff4_vir_reset" class="menu_button danger_button">⌫ Reset</button>
                    </div>
                </div>
            </div>
        </div>`);

    const wire = (id, prop, cb) => {
        const el = $(id); if (!el) return;
        el.checked = !!settings()[prop];
        el.addEventListener('change', function () {
            settings()[prop] = Boolean(this.checked);
            saveSettingsDebounced();
            if (cb) cb();
        });
    };
    wire('ff4_vir_enabled', 'enabled', async () => {
        await activateCurrentWorld();
        if (!settings().enabled) clearVirContract();
    });
    wire('ff4_vir_auto_hide', 'autoHideSyncedPackets');
    wire('ff4_vir_smart_tiers', 'smartTiers', async () => { await reapplyTiers(); });
    wire('ff4_vir_contract', 'contractInjection', async () => {
        if (settings().contractInjection) await injectVirContract();
        else clearVirContract();
    });
    const templateModeEl = $('ff4_vir_template_mode');
    if (templateModeEl) {
        templateModeEl.value = settings().templateMode || 'Detailed';
        templateModeEl.addEventListener('change', async function () {
            // v6 — template switch does NOT silently re-render existing entries
            // (§4.7 of plan). Existing entries keep their old shape until the
            // user clicks 🔄 on each row. The mismatch badge in the per-char
            // row will mark them as "out of date".
            settings().templateMode = this.value;
            saveSettingsDebounced();
            if (settings().contractInjection) await injectVirContract();
            updateStatus();
            renderCharacterList();
        });
    }
    wire('ff4_vir_seed_user', 'seedUserPersona', async () => { if (settings().seedUserPersona) await activateCurrentWorld(); });
    wire('ff4_vir_diagnostics', 'diagnosticsEnabled', updateStatus);
    wire('ff4_vir_bind_to_chat', 'bindToChat', async () => { await activateCurrentWorld(); });
    wire('ff4_vir_cleanup_delete', 'cleanupOnChatDelete');
    wire('ff4_vir_debug', 'debug');
    $('ff4_vir_chat_disabled')?.addEventListener('change', async function () {
        await setChatOverrides({ ...getChatOverrides(), disabled: Boolean(this.checked) });
        await activateCurrentWorld();
        updateStatus();
    });
    $('ff4_vir_chat_template_mode')?.addEventListener('change', async function () {
        await setChatOverrides({ ...getChatOverrides(), templateMode: this.value || '' });
        await activateCurrentWorld();
        updateStatus();
    });

    $('ff4_vir_activate')?.addEventListener('click', async () => {
        await activateCurrentWorld();
        updateStatus();
        renderCharacterList();
    });
    $('ff4_vir_refresh')?.addEventListener('click', () => { updateStatus(); renderCharacterList(); });
    // v6 P3-15 — Remind AI: forces an escalated VIR contract injection on
    // the NEXT turn by bumping the miss counter, so the priority reminder
    // jumps to its highest urgency level. Useful when the AI starts
    // skipping vir packets in long sessions.
    $('ff4_vir_remind')?.addEventListener('click', async () => {
        const st = settings();
        st.consecutiveMisses = Math.min(5, Math.max(3, (st.consecutiveMisses || 0) + 1));
        saveSettingsDebounced();
        await injectVirContract();
        if (typeof toastr !== 'undefined') {
            toastr.info('AI will receive an escalated VIR reminder on the next turn.', 'FF4 VIR');
        }
        updateStatus();
    });
    $('ff4_vir_copy_debug')?.addEventListener('click', copyVirDebugReport);
    $('ff4_vir_clear_warn')?.addEventListener('click', () => {
        settings().recentWarnings = [];
        saveSettingsDebounced();
        updateStatus();
    });
    $('ff4_vir_export')?.addEventListener('click', exportCurrentVir);
    $('ff4_vir_import')?.addEventListener('change', function () { importVirFile(this.files?.[0]); this.value = ''; });
    $('ff4_vir_reset')?.addEventListener('click', resetCurrentChatVir);

    // v6.1 — Batch refresh button
    $('ff4_vir_batch_refresh')?.addEventListener('click', () => batchRefreshAllCharacters());

    // v6.1 — Reset settings to defaults (does NOT touch lorebook)
    $('ff4_vir_reset_settings')?.addEventListener('click', () => {
        if (!confirm('Reset all extension settings to defaults? Your lorebook entries are untouched. This only affects toggles, sliders, and the template choice.')) return;
        const st = extension_settings[EXT];
        // Preserve per-world bindings + pinned + recall data — only reset prefs.
        const keep = {
            worldChatMap: st.worldChatMap,
            pinnedCharacters: st.pinnedCharacters,
            recallCharacters: st.recallCharacters,
        };
        extension_settings[EXT] = Object.assign({}, defaultSettings, keep);
        saveSettingsDebounced();
        renderSettings();
        if (typeof toastr !== 'undefined') toastr.success('Settings reset to defaults.', 'FF4 VIR');
    });

    // v6.1 — Refresh-context slider
    const turnsSlider = $('ff4_vir_refresh_turns');
    const turnsLabel = $('ff4_vir_refresh_turns_val');
    if (turnsSlider) {
        turnsSlider.value = String(settings().refreshContextTurns ?? 20);
        if (turnsLabel) turnsLabel.textContent = turnsSlider.value;
        turnsSlider.addEventListener('input', function () {
            settings().refreshContextTurns = parseInt(this.value) || 20;
            if (turnsLabel) turnsLabel.textContent = this.value;
            saveSettingsDebounced();
        });
    }

    // v6.1 — Refresh-cooldown slider
    const cooldownSlider = $('ff4_vir_refresh_cooldown');
    const cooldownLabel = $('ff4_vir_refresh_cooldown_val');
    if (cooldownSlider) {
        cooldownSlider.value = String(Math.round((settings().refreshDebounceMs ?? 30000) / 1000));
        if (cooldownLabel) cooldownLabel.textContent = cooldownSlider.value;
        cooldownSlider.addEventListener('input', function () {
            settings().refreshDebounceMs = (parseInt(this.value) || 30) * 1000;
            if (cooldownLabel) cooldownLabel.textContent = this.value;
            saveSettingsDebounced();
        });
    }

    updateStatus();
}

async function updateStatus() {
    const worldName = currentWorldName();
    const chatOverrides = getChatOverrides();
    const setEl = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setEl('ff4_vir_current_world', worldName || 'No active chat');
    setEl('ff4_vir_last_sync', settings().lastSyncStatus || 'No sync yet');
    setEl('ff4_vir_session_count', String(sessionPacketCount));
    const chatDisabledEl = $('ff4_vir_chat_disabled');
    if (chatDisabledEl) chatDisabledEl.checked = chatOverrides.disabled;
    const chatTemplateEl = $('ff4_vir_chat_template_mode');
    if (chatTemplateEl) chatTemplateEl.value = chatOverrides.templateMode || '';
    const chatTemplateHintEl = $('ff4_vir_chat_template_hint');
    if (chatTemplateHintEl) {
        const templateText = chatOverrides.templateMode
            ? `This chat overrides the global template (${settings().templateMode || 'Detailed'}) with ${chatOverrides.templateMode}.`
            : `Using global template: ${settings().templateMode || 'Detailed'}.`;
        const bindText = settings().bindToChat && chatOverrides.mergeIntoChatLore
            ? ' FF4 VIR is merged into the existing chat lorebook for this chat.'
            : settings().bindToChat ? ' FF4 VIR is using its own chat-lore slot for this chat.' : ' FF4 VIR is using global lorebook activation.';
        chatTemplateHintEl.textContent = `${templateText}${bindText}`;
    }

    const bound = chat_metadata?.[WI_METADATA_KEY] === worldName;
    const boundEl = $('ff4_vir_bound');
    if (boundEl) {
        boundEl.textContent = bound ? 'YES' : 'NO';
        boundEl.style.color = bound ? 'var(--success, #6f6)' : 'var(--warning, #d7a900)';
    }

    let chars = 0, totalChars = 0;
    if (worldName) {
        try {
            const data = await loadWorldInfo(worldName);
            if (data) {
                chars = characterCount(data);
                for (const e of Object.values(getEntries(data))) {
                    if (e && e.constant && !e.disable) totalChars += (e.content || '').length;
                }
            }
        } catch { /* ignore */ }
    }
    setEl('ff4_vir_char_count', String(chars));
    const tokenEl = $('ff4_vir_token_estimate');
    if (tokenEl) {
        const tokens = Math.round(totalChars / 3.8);
        tokenEl.textContent = `${tokens} tok (${totalChars} chars)`;
        tokenEl.style.color = tokens > 3000 ? 'var(--warning, #d7a900)' : 'var(--success, #6f6)';
    }

    // Warnings — limited to 5 most recent for cleaner display
    const warnEl = $('ff4_vir_warnings');
    const warnCountEl = $('ff4_vir_warn_count');
    const ws = settings().recentWarnings || [];
    if (warnCountEl) warnCountEl.textContent = String(ws.length);
    if (warnEl) {
        warnEl.innerHTML = ws.length
            ? ws.slice(0, 5).map(w => `<div class="ff4-vir-warning">${escapeHtml(w)}</div>`).join('')
            : '<div class="ff4-vir-muted">No recent warnings.</div>';
    }

    const diagEl = $('ff4_vir_diagnostics_body');
    if (diagEl) {
        if (!settings().diagnosticsEnabled) {
            diagEl.innerHTML = '<div class="ff4-vir-muted">Diagnostics disabled.</div>';
        } else {
            const snap = await buildDiagnosticsSnapshot();
            const rows = snap.characters.slice(0, 12).map(c =>
                `<div><b>[${escapeHtml(c.tier)}]</b> ${escapeHtml(c.name)} — ${escapeHtml(c.reason)} · depth ${escapeHtml(c.depth ?? '--')} · order ${escapeHtml(c.order ?? '--')}</div>`
            ).join('') || '<div>No character entries yet.</div>';
            diagEl.innerHTML = `
                <div><b>Mode:</b> ${escapeHtml(snap.templateMode)}${snap.chatTemplateOverride ? ` · <b>Chat override:</b> ${escapeHtml(snap.chatTemplateOverride)}` : ''} · <b>Disabled:</b> ${escapeHtml(String(snap.chatDisabled))} · <b>Depths:</b> contract ${VIR_CONTRACT_DEPTH}, state ${VIR_STATE_DEPTH}, priority ${VIR_PRIORITY_DEPTH}</div>
                <div><b>Misses:</b> streak ${escapeHtml(snap.missStreak)}, total ${escapeHtml(snap.totalMisses)} · <b>Tokens:</b> ${escapeHtml(snap.tokenEstimate)}</div>
                <div><b>Injection model:</b> v6 — character VIR entries are keyword-gated by SillyTavern. Tier flags adjust order/depth and only the seeded {{user}} entry may remain constant. No setExtensionPrompt dump.</div>
                <div>${rows}</div>`;
        }
    }

    await renderCharacterList();
}

// v6 P3-14 — VIR completeness % per character.
// Counts populated identity fields against the full schema, weights heavier
// for the load-bearing anchors (species/hair/eyes/skin/outfit). Used as a
// quick "is this entry well-populated or sparse" gauge in the UI.
const VIR_COMPLETENESS_FIELDS = [
    { k: 'species', w: 2 }, { k: 'age_appearance', w: 1 }, { k: 'height', w: 1 },
    { k: 'build', w: 1 }, { k: 'body_material', w: 0.5 }, { k: 'hair', w: 2 },
    { k: 'eyes', w: 2 }, { k: 'face_features', w: 1 }, { k: 'brow_lash', w: 0.5 },
    { k: 'lips_teeth', w: 0.5 }, { k: 'skin_fur_scales', w: 2 }, { k: 'body', w: 1 },
    { k: 'hands_feet', w: 0.5 }, { k: 'non_human', w: 1 }, { k: 'marks', w: 1 },
    { k: 'outfit', w: 2 }, { k: 'pose', w: 1 }, { k: 'expression', w: 1 },
    { k: 'location_context', w: 1 },
];
function virCompleteness(vir) {
    if (!vir || typeof vir !== 'object') return 0;
    let earned = 0, total = 0;
    for (const { k, w } of VIR_COMPLETENESS_FIELDS) {
        total += w;
        let v = vir[k];
        if (k === 'skin_fur_scales') v = v || vir.skin || vir.fur || vir.scales;
        if (k === 'outfit') {
            if (Array.isArray(v) ? v.length : (typeof v === 'string' && v.trim().length)) earned += w;
        } else if (typeof v === 'string' && v.trim().length) {
            earned += w;
        } else if (v && typeof v === 'object' && Object.keys(v).length) {
            earned += w;
        }
    }
    return total === 0 ? 0 : Math.round((earned / total) * 100);
}

// v6 §4.7 — detect when an existing entry's render shape doesn't match the
// active template. If `[LOCKED VISUAL CARD: ...]` appears but the template
// is Compact (which uses `[VIR: ...]`), the entry is "out of date" — the
// user can click 🔄 to bring it into the current template.
function entryRenderShape(content) {
    const s = String(content || '');
    if (s.includes('[LOCKED VISUAL CARD:')) return 'Detailed';
    if (/\[VIR:\s+[^\]]+\][\s\S]*Identity:/.test(s)) return 'Standard';
    if (/\[VIR:\s+[^\]]+\]/.test(s)) return 'Compact';
    return 'Unknown';
}
function entryMatchesActiveTemplate(content, activeTemplate) {
    const shape = entryRenderShape(content);
    if (shape === 'Unknown') return true; // can't tell — don't badge
    return shape === activeTemplate;
}

async function renderCharacterList() {
    const container = $('ff4_vir_char_list');
    if (!container) return;
    const worldName = currentWorldName();
    if (!worldName) {
        container.innerHTML = '<div class="ff4-vir-muted">No active chat.</div>';
        return;
    }
    let data; try { data = await loadWorldInfo(worldName); } catch { data = null; }
    if (!data) {
        container.innerHTML = '<div class="ff4-vir-muted">Could not load lorebook.</div>';
        return;
    }
    const chars = characterEntries(data);
    if (!chars.length) {
        container.innerHTML = '<div class="ff4-vir-muted">No characters yet. AI will populate as it emits <code>```vir</code> packets.</div>';
        return;
    }
    const st = settings();
    // v6 P2-9 — pinnedCharacters normalized to Set when read; persisted as
    // array (JSON-stable). Single canonical surface so add/remove paths
    // can't accidentally mix array/Set semantics.
    const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
    const recall = st.recallCharacters?.[worldName] || {};
    const activeTemplate = resolveTemplateMode(getEffectiveTemplate()).label;
    const rows = [];
    for (const [, entry] of chars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        const tierInfo = getCharacterTierInfo(entry, name, pinned, recall);
        const tier = tierInfo.tier;
        const tierColor = tierInfo.color;
        const vir = parseActiveVir(entry.content || '');
        const color = vir?.voice_lock?.dialogue_color || '';
        const pct = virCompleteness(vir);
        // Hue gradient: red (low) → yellow (~50%) → green (high).
        const pctColor = pct >= 70 ? '#6f6' : pct >= 40 ? '#d7a900' : '#d97070';
        const matches = entryMatchesActiveTemplate(entry.content || '', activeTemplate);
        const mismatchBadge = matches ? '' :
            `<span class="ff4-vir-mismatch-badge" title="This entry is in a different template format than your active selection (${activeTemplate}). Click 🔄 to re-render.">↻ ${activeTemplate}?</span>`;
        // v6.1 — token telemetry: show the actual rendered entry size in the
        // completeness chip tooltip. Helps users gauge how close to the
        // template's cap each entry is sitting.
        const entryTokens = estimateTokens(entry.content || '');
        const tokenInfo = `${entryTokens} tok in lorebook (current shape: ${entryRenderShape(entry.content || '')})`;
        // v6.1 — disable refresh button while cooldown is active, show remaining time.
        const locked = refreshIsLocked(name);
        const lockedSecs = locked ? refreshSecondsRemaining(name) : 0;
        const refreshTitle = locked
            ? `Cooldown: wait ${lockedSecs}s before refreshing again.`
            : `Re-run AI to refresh this character in the current template (${activeTemplate}).`;
        // v6.1 — character row gets data-entry-preview for the hover tooltip.
        // Stored URI-encoded so the HTML attribute can't be broken by quotes.
        const preview = (entry.content || '').slice(0, 1500);
        const previewAttr = encodeURIComponent(preview);
        rows.push(`<div class="ff4-vir-char-row">
            <span class="ff4-vir-preview-trigger" data-entry-preview="${previewAttr}">
                <span class="ff4-vir-char-tier" style="color:${tierColor}">[${tier}]</span>
                <span class="ff4-vir-char-name">${escapeHtml(name)}</span>
                <span class="ff4-vir-char-completeness" style="color:${pctColor}" title="VIR completeness ${pct}% — fraction of identity fields populated, weighted by importance.\n${tokenInfo}">${pct}%</span>
                ${mismatchBadge}
                ${color ? `<span style="color:${color};font-weight:600" title="Dialogue colour: ${color}">●</span>` : ''}
            </span>
            <button class="ff4-vir-pin-btn menu_button" data-name="${escapeHtml(name)}" data-action="${pinned.has(name) ? 'park' : 'pin'}">${pinned.has(name) ? 'Unpin' : 'Pin'}</button>
            <button class="ff4-vir-refresh-btn menu_button" data-name="${escapeHtml(name)}" title="${escapeHtml(refreshTitle)}" ${locked ? 'disabled' : ''}><span class="fa-solid fa-rotate-right"></span></button>
        </div>`);
    }
    container.innerHTML = rows.join('');

    // v6.1 — hover tooltip showing the full rendered entry content.
    // Attached once; reuses a single popover element.
    let _previewPopover = document.getElementById('ff4_vir_preview_popover');
    if (!_previewPopover) {
        _previewPopover = document.createElement('div');
        _previewPopover.id = 'ff4_vir_preview_popover';
        _previewPopover.className = 'ff4-vir-preview-popover';
        document.body.appendChild(_previewPopover);
    }
    container.querySelectorAll('.ff4-vir-preview-trigger[data-entry-preview]').forEach(trigger => {
        trigger.addEventListener('mouseenter', () => {
            const text = decodeURIComponent(trigger.getAttribute('data-entry-preview') || '');
            if (!text) return;
            _previewPopover.textContent = text;
            _previewPopover.style.display = 'block';
            // Position to the right of the row (or below if no room).
            const rect = trigger.getBoundingClientRect();
            const popW = Math.min(420, window.innerWidth - 40);
            _previewPopover.style.maxWidth = popW + 'px';
            const left = Math.min(rect.right + 12, window.innerWidth - popW - 10);
            _previewPopover.style.left = Math.max(10, left) + 'px';
            _previewPopover.style.top = (rect.top + window.scrollY) + 'px';
        });
        trigger.addEventListener('mouseleave', () => {
            _previewPopover.style.display = 'none';
        });
    });
    container.querySelectorAll('.ff4-vir-pin-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.getAttribute('data-name');
            const action = btn.getAttribute('data-action');
            const worldName = currentWorldName();
            if (!worldName || !name) return;
            if (action === 'pin') pinCharacter(worldName, name);
            else unpinCharacter(worldName, name);
            await reapplyTiers();
            updateStatus();
        });
    });
    // v6 P3-13b — Refresh button: one-off generation that re-emits this
    // character only in the currently-selected template.
    container.querySelectorAll('.ff4-vir-refresh-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.getAttribute('data-name');
            if (!name || btn.classList.contains('ff4-vir-busy')) return;
            btn.classList.add('ff4-vir-busy');
            btn.innerHTML = '<span class="fa-solid fa-spinner fa-spin"></span>';
            btn.disabled = true;
            try {
                await refreshCharacterViaAI(name);
            } catch (err) {
                error('Refresh failed:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error(`Refresh failed: ${err?.message || err}`, 'FF4 VIR');
                }
            } finally {
                btn.classList.remove('ff4-vir-busy');
                await updateStatus();
            }
        });
    });
}

// ============================================================================
// v6 P3-13b — Manual VIR Refresh Flow
// ============================================================================
// Triggered by the 🔄 button next to each character row in the settings panel.
// Sends a one-off, non-streaming generation request that asks the AI to
// re-emit this one character's VIR sheet in the currently-selected template,
// preserving established identity facts and incorporating any visible changes
// from recent chat history. Only that one character's entry is touched.
const REFRESH_DEFAULT_CONTEXT_TURNS = 20;
// v6.1 — per-character debounce so click-spam doesn't burn tokens.
// Map: characterName (lowercase) → unix-ms of last successful refresh.
const _refreshLastSuccess = new Map();
let _batchRefreshActive = false;
function refreshIsLocked(name) {
    const cooldownMs = settings().refreshDebounceMs || 30000;
    const last = _refreshLastSuccess.get(String(name || '').toLowerCase());
    if (!last) return false;
    return (Date.now() - last) < cooldownMs;
}
function refreshSecondsRemaining(name) {
    const cooldownMs = settings().refreshDebounceMs || 30000;
    const last = _refreshLastSuccess.get(String(name || '').toLowerCase());
    if (!last) return 0;
    return Math.max(0, Math.ceil((cooldownMs - (Date.now() - last)) / 1000));
}

// v6.1 — read chat tail size from settings; clamp to sane bounds.
function getRefreshContextTurns() {
    const n = parseInt(settings().refreshContextTurns);
    if (Number.isFinite(n) && n >= 0 && n <= 80) return n;
    return REFRESH_DEFAULT_CONTEXT_TURNS;
}
function buildChatTailForRefresh() {
    try {
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const n = getRefreshContextTurns();
        if (n <= 0 || !chat.length) return '';
        const slice = chat.slice(-n);
        return slice.map((m) => {
            if (!m) return '';
            const who = m.is_user ? '[USER]' : m.is_system ? '[SYS]' : `[${m.name || 'AI'}]`;
            return `${who} ${String(m.mes || '').replace(/\s+/g, ' ').slice(0, 800)}`;
        }).filter(Boolean).join('\n');
    } catch (e) {
        warn('buildChatTailForRefresh failed', e?.message);
        return '';
    }
}
function buildRefreshContract(name, templateMode, existingContent) {
    const mode = resolveTemplateMode(templateMode);
    const tail = buildChatTailForRefresh();
    return [
        `You are refreshing the Visual Identity Registry (VIR) sheet for ONE character.`,
        '',
        `TARGET CHARACTER: ${name}`,
        `TARGET TEMPLATE: ${mode.label}`,
        `HARD BUDGET: ≤${mode.budgetTokens} tokens for this character's block.`,
        '',
        'INSTRUCTIONS:',
        `1. Preserve every established stable identity fact from the EXISTING VIR below.`,
        `   Stable identity = species, age, height, build, hair, eyes, skin, face,`,
        `   marks, non-human features, body, anatomy.`,
        `2. Update mutable state (outfit, accessories, holding, pose, expression,`,
        `   condition, location_context, hair_state) ONLY from the RECENT CHAT block below.`,
        `   Do not infer changes from any other hidden scene/context source.`,
        `3. Emit ONE \`\`\`vir code-fence containing EXACTLY this structure for ${name}:`,
        `   [ACTIVE VIR: ${name}]`,
        `   Canonical name+source for image prompts: ...`,
        `   [LOCKED VISUAL CARD: ${name}]`,
        `   ...field lines...`,
        `   [/LOCKED VISUAL CARD]`,
        `   [/ACTIVE VIR]`,
        `   Do not include JSON, other characters, scene metadata, recall, or commentary.`,
        `   The fence is the only output.`,
        `4. This is structured refresh data only. The extension will re-render it into the TARGET TEMPLATE (${mode.label}) after parsing.`,
        `5. Stay inside the ${mode.budgetTokens}-token budget.`,
        '',
        `EXISTING VIR SHEET FOR ${name}:`,
        existingContent || '(no existing entry — create from chat context)',
        '',
        tail ? `RECENT CHAT (last ${getRefreshContextTurns()} messages):` : '',
        tail,
    ].filter(Boolean).join('\n');
}

async function refreshCharacterViaAI(name, opts = {}) {
    if (!name) throw new Error('character name required');
    // v6.1 — debounce check; opts.bypassDebounce lets batch refresh skip it.
    if (!opts.bypassDebounce && refreshIsLocked(name)) {
        const secs = refreshSecondsRemaining(name);
        throw new Error(`${name} was just refreshed (cooldown ${secs}s)`);
    }
    const worldName = currentWorldName();
    if (!worldName) throw new Error('no active chat');
    const ctx = getContext();
    if (!ctx) throw new Error('no SillyTavern context');

    // Locate generation function — ST exposes generateRaw() on the context object.
    // Older builds may attach it as window.generateRaw; fall back if needed.
    const generateRaw = ctx.generateRaw || (typeof window !== 'undefined' && window.generateRaw);
    if (typeof generateRaw !== 'function') {
        throw new Error('generateRaw() unavailable in this SillyTavern build');
    }

    const data = await loadWorldInfo(worldName);
    if (!data) throw new Error('could not load lorebook');
    const existing = findCharacterEntry(data, name);
    const existingContent = existing?.content || '';

    const templateMode = getEffectiveTemplate();
    const systemPrompt = buildRefreshContract(name, templateMode, existingContent);
    const userPrompt = `Refresh VIR for ${name}.`;

    log(`Refresh: requesting one-off generation for ${name} in ${templateMode}`);
    if (typeof toastr !== 'undefined') {
        toastr.info(`Refreshing ${name}…`, 'FF4 VIR', { timeOut: 2000 });
    }

    // ST's generateRaw signature varies across versions. Try the modern object
    // form first, fall back to positional. Both return a string (the AI reply).
    let reply;
    try {
        reply = await generateRaw({
            prompt: userPrompt,
            systemPrompt,
            quietToLoud: false,
            noContext: true,   // refresh must use only the explicit RECENT CHAT tail in systemPrompt
        });
    } catch (e1) {
        try {
            reply = await generateRaw(userPrompt, null, false, true, systemPrompt);
        } catch (e2) {
            throw new Error(`generateRaw failed: ${e1?.message || e1}`);
        }
    }
    if (!reply || typeof reply !== 'string') throw new Error('empty AI response');

    // Extract vir fence + parse. Reuse the same regex the main flow uses.
    let virBlockMatch = reply.match(/```vir\b\s*\n?([\s\S]*?)\n?```/i);
    if (!virBlockMatch) virBlockMatch = reply.match(/<vir_sync\b[^>]*>([\s\S]*?)<\/vir_sync>/i);
    if (!virBlockMatch) throw new Error('AI returned no vir block');
    const expectedName = canonicalizeName(name).canonical;
    const blockText = virBlockMatch[1].trim();
    let newVir = null;
    let returnedName = expectedName;
    try {
        const parsed = parsePacket(blockText);
        if (!parsed) throw new Error('vir packet parsed but empty');

        // Find this character's entry inside the packet.
        let charPayload = null;
        if (Array.isArray(parsed.characters)) {
            charPayload = parsed.characters.find(c => {
                if (!c?.name) return false;
                return canonicalizeName(c.name).canonical === expectedName;
            });
        }
        if (!charPayload && parsed.new_characters) {
            for (const [k, v] of Object.entries(parsed.new_characters)) {
                if (canonicalizeName(k).canonical === expectedName) {
                    charPayload = { name: k, ...v };
                    break;
                }
            }
        }
        if (!charPayload && parsed.vir_delta) {
            for (const [k, v] of Object.entries(parsed.vir_delta)) {
                if (canonicalizeName(k).canonical === expectedName) {
                    charPayload = { name: k, ...v };
                    break;
                }
            }
        }
        if (!charPayload) {
            throw new Error(`AI returned a vir block but no entry for "${name}"`);
        }

        returnedName = canonicalizeName(charPayload.name).canonical;
        newVir = flatCharToNested(charPayload);
    } catch (packetErr) {
        const parsedCard = parseRefreshCharacterBlock(blockText, name);
        if (!parsedCard) {
            throw new Error(`could not parse vir packet: ${packetErr.message}`);
        }
        returnedName = canonicalizeName(parsedCard.name).canonical;
        newVir = parsedCard.vir;
    }
    if (returnedName !== expectedName) {
        throw new Error(`AI returned "${returnedName}" instead of "${expectedName}"`);
    }
    if (!newVir || !Object.keys(newVir).length) {
        throw new Error('parsed refresh block but no VIR fields were found');
    }

    // Safety: never let a refresh catastrophically shorten an entry.
    if (existing) {
        const oldVir = parseActiveVir(existing.content || '');
        const oldPopulated = VIR_CORE_ANCHORS.filter(k => {
            const v = oldVir[k] || (k === 'skin_fur_scales' && (oldVir.skin || oldVir.fur || oldVir.scales));
            return typeof v === 'string' && v.trim().length > 0;
        }).length;
        const newPopulated = VIR_CORE_ANCHORS.filter(k => {
            const v = newVir[k] || (k === 'skin_fur_scales' && (newVir.skin || newVir.fur || newVir.scales));
            return typeof v === 'string' && v.trim().length > 0;
        }).length;
        if (oldPopulated > 2 && newPopulated < Math.ceil(oldPopulated * 0.5)) {
            throw new Error(`AI refresh dropped too many fields (${oldPopulated} → ${newPopulated}); aborting`);
        }
    }

    // Apply. upsertCharacter handles save via setActiveFlags + saveWorldInfo
    // outside, so we save explicitly here.
    upsertCharacter(data, name, { vir: newVir });
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    // v6.1 — record success timestamp for debounce.
    _refreshLastSuccess.set(String(name).toLowerCase(), Date.now());
    log(`Refresh: ${name} updated`);
    if (typeof toastr !== 'undefined' && !opts.silent) {
        toastr.success(`Refreshed ${name}`, 'FF4 VIR', { timeOut: 3000 });
    }
}

// v6.1 — batch refresh: iterate all characters sequentially. Per-char
// debounce is bypassed (the user explicitly opted in by clicking "Refresh
// all"). Progress is reported via a single sticky toastr that updates as
// each character completes. Aborts cleanly on first error.
async function batchRefreshAllCharacters() {
    if (_batchRefreshActive) {
        if (typeof toastr !== 'undefined') toastr.info('Batch refresh already running.', 'FF4 VIR');
        return;
    }
    const worldName = currentWorldName();
    if (!worldName) {
        if (typeof toastr !== 'undefined') toastr.warning('No active chat.', 'FF4 VIR');
        return;
    }
    const data = await loadWorldInfo(worldName);
    if (!data) {
        if (typeof toastr !== 'undefined') toastr.error('Could not load lorebook.', 'FF4 VIR');
        return;
    }
    const chars = characterEntries(data).map(([, e]) => characterEntryName(e)).filter(Boolean);
    if (!chars.length) {
        if (typeof toastr !== 'undefined') toastr.info('No characters to refresh.', 'FF4 VIR');
        return;
    }
    if (!confirm(`Refresh ${chars.length} character(s)? This will send one AI generation per character (≈${chars.length} extra generations).`)) return;

    _batchRefreshActive = true;
    const errors = [];
    let progressToast = null;
    try {
        for (let i = 0; i < chars.length; i++) {
            const name = chars[i];
            if (typeof toastr !== 'undefined') {
                if (progressToast?.toastId) toastr.clear(progressToast);
                progressToast = toastr.info(`Refreshing ${i + 1}/${chars.length}: ${name}…`, 'FF4 VIR', { timeOut: 0 });
            }
            try {
                await refreshCharacterViaAI(name, { bypassDebounce: true, silent: true });
            } catch (err) {
                errors.push(`${name}: ${err?.message || err}`);
                warn(`Batch refresh failed for ${name}:`, err);
            }
        }
    } finally {
        _batchRefreshActive = false;
        if (progressToast && typeof toastr !== 'undefined') toastr.clear(progressToast);
    }
    if (typeof toastr !== 'undefined') {
        if (errors.length) {
            toastr.warning(`Batch refresh complete with ${errors.length} error(s). See console.`, 'FF4 VIR', { timeOut: 8000 });
            console.warn(`[${EXT}] Batch refresh errors:`, errors);
        } else {
            toastr.success(`Batch refresh complete: ${chars.length} character(s) refreshed.`, 'FF4 VIR', { timeOut: 5000 });
        }
    }
    renderCharacterList();
    updateStatus();
}

// ============================================================================
// EXPORT / IMPORT / RESET
// ============================================================================
async function exportCurrentVir() {
    const worldName = currentWorldName();
    if (!worldName) return toastr.warning('No active VIR lorebook.', 'FF4 VIR');
    const data = await loadWorldInfo(worldName);
    if (!data) return toastr.warning('Failed to load lorebook.', 'FF4 VIR');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${worldName}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importVirFile(file) {
    if (!file) return;
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        const worldName = currentWorldName();
        if (!worldName) return toastr.warning('No active chat.', 'FF4 VIR');
        await saveWorldInfo(worldName, data, true);
        await updateWorldInfoList();
        toastr.success('VIR imported.', 'FF4 VIR');
        updateStatus();
    } catch (e) { toastr.error(`Import failed: ${e.message}`, 'FF4 VIR'); }
}
async function resetCurrentChatVir() {
    const worldName = currentWorldName();
    if (!worldName) return;
    if (isVirWorldName(worldName)) {
        if (!confirm('Reset all VIR data for current chat? This deletes the lorebook.')) return;
        await deleteVirWorld(worldName);
        await updateWorldInfoList();
        toastr.info('Chat VIR reset.', 'FF4 VIR');
        updateStatus();
        return;
    }
    if (!confirm('Reset FF4 VIR entries for this chat? This will remove FF4-managed VIR entries from the current chat lorebook but keep the lorebook itself.')) return;
    const removed = await clearVirEntriesFromWorld(worldName);
    await setChatOverrides({ ...getChatOverrides(), mergeIntoChatLore: false });
    toastr.info(`Removed ${removed} FF4 VIR entr${removed === 1 ? 'y' : 'ies'} from "${worldName}".`, 'FF4 VIR');
    updateStatus();
    return;
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
// v6 — P1-5 fix: listener idempotency. Earlier versions registered listeners
// at every init (boot, settings reload, debug menu reset). Toggling the
// extension or reloading settings would accumulate handlers, so each event
// fired N+1 times after N toggles. The flag below makes attachListeners()
// a no-op on the second call.
let _listenersAttached = false;
function attachListeners() {
    if (_listenersAttached) return;
    _listenersAttached = true;
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await activateCurrentWorld();
        renderCharacterList();
        if (settings().dialogueColorEnabled) setTimeout(applyDialogueColors, 200);
    });
    eventSource.on(event_types.CHAT_CREATED, async () => {
        await activateCurrentWorld();
        renderCharacterList();
    });
    eventSource.on(event_types.GROUP_CHAT_CREATED, async () => {
        await activateCurrentWorld();
        renderCharacterList();
    });
    eventSource.on(event_types.CHAT_DELETED, cleanupVirForDeletedChat);
    eventSource.on(event_types.GROUP_CHAT_DELETED, cleanupVirForDeletedChat);

    // ── GENERATION_ENDED — parse VIR data + strip msg.mes (RPG HUD pattern) ──
    // This fires once after the full AI response. Safe to modify msg.mes and
    // saveChat() here without racing ComfyUI's async image injection.
    eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);

    // ── MESSAGE_RECEIVED — DOM-only strip (never touch msg.mes) ──
    // Removes rendered ```vir fences from the visible DOM during streaming.
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);

    // ── CHARACTER_MESSAGE_RENDERED — DOM-only strip after full render ──
    // Catches any VIR content that survived into the final rendered HTML.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (mesId) => {
        await handleMessageRendered(mesId);
        if (settings().dialogueColorEnabled) applyDialogueColors();
    });
}

jQuery(async () => {
    settings();
    renderSettings();
    attachListeners();
    registerSlashCommands();
    await activateCurrentWorld();
    log(`v${VERSION} initialized (RPG-HUD-aligned event model)`);
});

// ── v5.5 dialogue colour CSS application ────────────────────────────────────
// Reads voice_lock.dialogue_color for each character in the current chat's VIR
// world and applies the colour to that character's .name_text label in chat DOM.
// Pure DOM styling — no markdown injection, no message mutation.
async function getDialogueColorMap() {
    if (isVirDisabledForChat()) return new Map();
    const worldName = currentWorldName();
    if (!worldName) return new Map();
    const data = await loadWorldInfo(worldName).catch(() => null);
    if (!data) return new Map();
    const map = new Map();
    for (const [, entry] of characterEntries(data)) {
        const name = characterEntryName(entry);
        const vir = parseActiveVir(entry.content || '');
        const color = String(vir?.voice_lock?.dialogue_color || '').trim();
        if (name && /^#[0-9a-f]{3,8}$/i.test(color)) {
            map.set(name.toLowerCase(), color);
        }
    }
    return map;
}

async function applyDialogueColors() {
    try {
        const map = await getDialogueColorMap();
        if (!map.size) return;
        document.querySelectorAll('#chat .mes .name_text').forEach(node => {
            const label = String(node.textContent || '').trim().toLowerCase();
            if (!label) return;
            // Match exact, or first-word match (handles "Belne the Bold")
            let color = map.get(label);
            if (!color) {
                const first = label.split(/\s+/)[0];
                if (first) color = map.get(first);
            }
            if (color) node.style.color = color;
            else node.style.removeProperty('color');
        });
    } catch (err) {
        warn('applyDialogueColors failed', err?.message);
    }
}

