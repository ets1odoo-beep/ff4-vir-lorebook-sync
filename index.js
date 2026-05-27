// FF4 VIR Lorebook Sync — v5.1.1 (state entries removed from lorebook)
// Auto-injects the VIR contract; AI emits ```vir code-fence blocks; extension
// parses, updates lorebook entries dynamically (smart tier system), strips
// JSON from visible chat. Only character VIR cards + roster stored in lorebook.
// Scene/state data is NOT stored — active chars derived from each VIR packet.

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
const VERSION = '5.2.0';
const WORLD_PREFIX = 'FF4 VIR - ';

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
    contractInjection: true,         // auto-inject VIR contract via setExtensionPrompt
    seedUserPersona: true,           // auto-seed a pinned VIR entry from the active persona
    recallTurnsDefault: 8,           // longer than v4 for better long-term memory
    templateMode: 'Detailed',
    diagnosticsEnabled: true,
    sheetCommandMode: 'Detailed',
    lastInjectionPreview: '',
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

const VIR_TEMPLATE_MODES = {
    Compact: {
        label: 'Compact',
        summary: 'Low-token mode. Keep VIR packets short and practical.',
        rules: [
            'Use the minimum fields needed to keep continuity stable.',
            'On create: emit the stable visual identity core plus current outfit, pose, expression, condition, and location_context.',
            'On update: emit only fields that visibly changed this turn. Do not restate stable identity unless it was missing or wrong.',
            'Prefer short image-friendly values over long descriptive chains.',
            'Omit optional flourish, interpretation, and redundant synonyms.',
        ],
    },
    Detailed: {
        label: 'Detailed',
        summary: 'Balanced default. Full visual identity when needed, but not bloated.',
        rules: [
            'On create or repair: emit full visual identity detail with enough specificity for consistent image prompting.',
            'Preserve stable identity exactly after creation unless the story explicitly changes it.',
            'On update: focus on changed outfit, pose, expression, condition, exposure, accessories, and location_context.',
            'Keep values concrete and image-friendly without repeating the whole sheet every turn.',
            'If a field is weak for image use, repair it once and then keep it stable.',
        ],
    },
    'VN Director': {
        label: 'VN Director',
        summary: 'Continuity-first mode. Prioritize scene blocking and active cast staging.',
        rules: [
            'Treat VIR like a VN continuity bible, not a character encyclopedia.',
            'Prioritize scene.active, location, location_context, position, pose, expression, condition, who is on-screen, and who is off-screen.',
            'Track entrances, exits, viewpoint changes, seating/standing positions, who faces whom, and visible distance/placement shifts.',
            'Keep outfit and exposure current, but do not over-expand stable anatomy unless needed for continuity repair.',
            'When only staging changes, update staging cleanly instead of rewriting identity.',
        ],
    },
    'Image Heavy': {
        label: 'Image Heavy',
        summary: 'Image-consistency-first mode. Strongest visual anchors.',
        rules: [
            'Prioritize image consistency above brevity.',
            'On create or repair: make every visible image-relevant field renderable on its own.',
            'Stable anchors must be complete and explicit: full_name, source, species, age_appearance, height, build, body_material, hair, eyes, skin/fur/scales, face_features, body, marks, non_human.',
            'Current visual anchors must stay exact: outfit pieces and layers, underwear state, accessories, equipment, exposure, pose, expression, condition, and location_context.',
            'Sexual or intense context never implies undressing or exposure changes unless the story explicitly changed them.',
            'If a visual field is vague, repair it into plain concrete visual language.',
        ],
    },
};

function buildTemplateModeBlock(mode) {
    const rules = Array.isArray(mode?.rules) ? mode.rules : [];
    return [
        `[VIR TEMPLATE MODE: ${mode?.label || 'Detailed'}]`,
        mode?.summary || '',
        '',
        '[MODE RULES]',
        ...rules.map(rule => `- ${rule}`),
        '[/MODE RULES]',
        '[/VIR TEMPLATE MODE]',
    ].filter(Boolean).join('\n');
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
function currentWorldName() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const stableId = chat_metadata?.integrity || chatId;
    const suffix = hashString(stableId);
    const bound = chat_metadata?.[WI_METADATA_KEY];
    if (bound && isVirWorldName(bound) && (world_names || []).includes(bound)) return bound;
    const existing = (world_names || []).find(n => String(n).startsWith(WORLD_PREFIX) && String(n).endsWith(`-${suffix}`));
    if (existing) return existing;
    const mapped = settings().worldChatMap || {};
    const fromMap = Object.entries(mapped).find(([w, info]) => info?.chatId === String(chatId) && (world_names || []).includes(w));
    if (fromMap) return fromMap[0];
    return `${WORLD_PREFIX}${safeNamePart(chatId)}-${suffix}`;
}
function rememberWorldChat(worldName, chatId = getCurrentChatId()) {
    if (!worldName || !chatId) return;
    const st = settings();
    st.worldChatMap = st.worldChatMap || {};
    st.worldChatMap[worldName] = { chatId: String(chatId), integrity: chat_metadata?.integrity || null, updatedAt: Date.now() };
    saveSettingsDebounced();
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

function lockedVisualCard(name, vir = {}) {
    const skin = vir.skin_fur_scales || vir.skin || vir.fur || vir.scales;
    const anatomy = vir.anatomy || vir.genitals || vir.nsfw_anatomy;
    const condition = compactValue([
        vir.condition,
        vir.aftermath_marks || (Number(vir.aftermath) > 0 ? `aftermath active (${vir.aftermath} turns)` : ''),
        vir.body_fluids,
        vir.injuries,
        vir.dishevelment,
    ]);
    const lines = [
        `[LOCKED VISUAL CARD: ${name}]`,
        `# --- STABLE IDENTITY (changes only when story drives it) ---`,
        `PIC_IDENTITY: ${buildPicIdentity(name, vir)}`,
        `IDENTITY: ${compactValue([vir.species || vir.species_class, canonicalSourceName(vir), vir.age_appearance, vir.height, vir.build])}`,
        `BODY_MATERIAL: ${compactValue(vir.body_material || vir.composition || vir.material)}`,
        `HAIR: ${compactValue(vir.hair)}`,
        `EYES: ${compactValue(vir.eyes)}`,
        `FACE_FEATURES: ${compactValue(vir.face_features || vir.face)}`,
        `BROW_LASH: ${compactValue(vir.brow_lash || vir.brows_lashes)}`,
        `LIPS_TEETH: ${compactValue(vir.lips_teeth || vir.lips)}`,
        `SKIN/FUR/SCALES: ${compactValue(skin)}`,
        `BODY/ANATOMY: ${compactValue([vir.body, anatomy])}`,
        `HANDS_FEET: ${compactValue(vir.hands_feet || vir.hands)}`,
        `NON-HUMAN: ${compactValue(vir.non_human || vir.limb_config)}`,
        `MARKS: ${compactValue(vir.marks)}`,
        `# --- CURRENT STATE (updates each scene) ---`,
        `HAIR_NOW: ${compactValue(vir.hair_state || vir.hair_now || vir.hairstyle_now)}`,
        ...compactList('OUTFIT ', vir.outfit || vir.outfit_layers),
        ...compactList('UNDERWEAR ', vir.underwear),
        ...compactList('ACCESSORY ', vir.accessories),
        ...compactList('EQUIPMENT ', vir.equipment),
        `HOLDING: ${compactValue(vir.holding || vir.held_items || vir.in_hands)}`,
        `POSE: ${compactValue(vir.pose || vir.posture || vir.posture_voice)}`,
        `EXPRESSION: ${compactValue(vir.expression || vir.default_expression)}`,
        `CONDITION: ${condition}`,
        `LOCATION_CONTEXT: ${compactValue(vir.location_context || vir.location)}`,
        vir.voice_lock?.dialogue_color ? `DIALOGUE_COLOR: ${vir.voice_lock.dialogue_color}` : '',
        `[/LOCKED VISUAL CARD]`,
    ].filter(line => {
        if (!line) return false;
        if (line.startsWith('# ---')) return true;
        if (line.endsWith(': ') || line.endsWith(':')) return false;
        return true;
    });
    return lines.join('\n');
}

function characterContent(name, payload = {}) {
    const vir = payload.vir || payload;
    const picIdentity = buildPicIdentity(name, vir);
    return `[ACTIVE VIR: ${name}]
Canonical name+source for image prompts: ${picIdentity || name}
${lockedVisualCard(name, vir)}
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
    return parseCardLines(m[1]);
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
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'FF4 FF4_STATE' || entry.comment === 'FF4 VIR Roster') return false;
        return Boolean(characterEntryName(entry));
    });
}
function characterCount(data) { return characterEntries(data).length; }
function findCharacterEntry(data, name) {
    const target = canonicalizeName(name).canonical.toLowerCase();
    return Object.values(getEntries(data)).find(entry => {
        if (!entry || entry.comment === 'FF4 VIR Rules') return false;
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

function applyDelta(data, name, delta) {
    if (!name || !delta) return;
    name = canonicalizeName(name, delta).canonical;
    const current = findCharacterEntry(data, name);
    const oldVir = current ? parseActiveVir(current.content) : {};
    if (current) checkVirDrift(name, oldVir, delta);
    return upsertCharacter(data, name, { vir: mergeVir(oldVir, delta) });
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
        const st = settings();
        st.pinnedCharacters = st.pinnedCharacters || {};
        st.pinnedCharacters[worldName] = st.pinnedCharacters[worldName] || [];
        const canonical = canonicalizeName(personaName).canonical;
        if (!st.pinnedCharacters[worldName].includes(canonical)) {
            st.pinnedCharacters[worldName].push(canonical);
            saveSettingsDebounced();
        }
        log(`Seeded user persona VIR: ${personaName}`);
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
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'FF4 FF4_STATE' || entry.comment === 'FF4 VIR Roster') continue;
        const name = characterEntryName(entry);
        if (!name) continue;
        normalizeLegacyPicCopy(entry);
        enforceVirRecursionFlags(entry);
        if (pinnedNames.has(name)) {
            entry.constant = true; entry.order = TIER.PINNED.order; entry.depth = TIER.PINNED.depth;
        } else if (activeNames.has(name)) {
            entry.constant = true; entry.order = TIER.ACTIVE.order; entry.depth = TIER.ACTIVE.depth;
        } else if (recallNames.has(name)) {
            entry.constant = true; entry.order = TIER.RECALL.order; entry.depth = TIER.RECALL.depth;
        } else {
            // OFFSCREEN — smart mode: keyword-only (no constant); else: behave like active
            if (smart) {
                entry.constant = false; entry.order = TIER.OFFSCREEN.order; entry.depth = TIER.OFFSCREEN.depth;
            } else {
                entry.constant = true; entry.order = TIER.ACTIVE.order; entry.depth = TIER.ACTIVE.depth;
            }
        }
    }
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
// SCHEMA RULES entry — REMOVED (v5.0.1)
// The VIR_CONTRACT is already injected via setExtensionPrompt as a system
// prompt, so a separate lorebook entry was redundant and caused the AI to
// double-emit vir_delta.  ensureSchemaEntry now CLEANS UP any leftover entry.
// ============================================================================
function ensureSchemaEntry(data) {
    const entries = getEntries(data);
    const entry = Object.values(entries).find(e => e?.comment === 'FF4 VIR Rules');
    if (entry) {
        delete entries[entry.uid];
        log('Removed obsolete FF4 VIR Rules lorebook entry');
    }
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
    const result = robustJsonParse(packet.body);
    const data = result.data;
    if (!data || typeof data !== 'object') throw new Error('Packet is not an object');
    if (data.schema !== 1 && data.schema !== 2 && data.schema !== 3) throw new Error(`Unsupported schema: ${data.schema}`);
    if (result.recovered) log(`JSON recovered via pass ${result.repairAttempts}`);
    return data;
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
    let data = await loadWorldInfo(worldName);
    if (!data || typeof data !== 'object') data = { entries: {} };
    getEntries(data);
    ensureSchemaEntry(data);
    ensureFF4StateEntry(data);      // cleanup obsolete lorebook entry
    cleanupSceneStateEntry(data);   // migrate + cleanup obsolete lorebook entry
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    return data;
}
async function activateCurrentWorld() {
    if (!settings().enabled) return;
    const worldName = currentWorldName();
    if (!worldName) return;
    const data = await ensureWorldLoaded(worldName);
    rememberWorldChat(worldName);
    // Phase 1 — seed the user persona VIR so {{user}} is tracked too.
    try {
        seedUserPersonaVir(worldName, data);
        rebuildRosterEntry(data);
        await saveWorldInfo(worldName, data, true);
    } catch (e) { warn('user persona seed failed', e); }
    const wiSettings = getWorldInfoSettings();
    // selected_world_info is a module-level `let` exported from world-info.js — it's the
    // backing array for ST's "Active World(s) for all chats" UI. NOT part of wiSettings.
    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    const nextGlobal = [...active.filter(n => n !== worldName && !isVirWorldName(n)), worldName];
    updateWorldInfoSettings(wiSettings, [...new Set(nextGlobal)]);
    if (settings().bindToChat && typeof chat_metadata === 'object') {
        if (chat_metadata[WI_METADATA_KEY] !== worldName) {
            chat_metadata[WI_METADATA_KEY] = worldName;
            try { await saveMetadata(); } catch (e) { warn('saveMetadata failed', e); }
        }
    }
    injectVirContract();
    await injectVirState();
    updateStatus();
}
async function deleteVirWorld(worldName) {
    if (!isVirWorldName(worldName)) return false;
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(selected_world_info) ? selected_world_info : [];
    updateWorldInfoSettings(wiSettings, active.filter(n => n !== worldName));
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

function injectVirContract() {
    if (!settings().enabled || !settings().contractInjection) return;
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        const mode = VIR_TEMPLATE_MODES[settings().templateMode] || VIR_TEMPLATE_MODES.Detailed;
        const contract = `${VIR_CONTRACT}

${buildTemplateModeBlock(mode)}`;
        // Main contract at depth 4 (full reference).
        setExtensionPrompt('FF4_VIR_CONTRACT', contract, POSITION_IN_CHAT, VIR_CONTRACT_DEPTH, false, 'system');
        // Priority reminder at depth 1 — fresh attention anchor. Escalates if AI keeps missing.
        const priority = buildPriorityReminder();
        setExtensionPrompt('FF4_VIR_PRIORITY', priority, POSITION_IN_CHAT, VIR_PRIORITY_DEPTH, false, 'system');
        settings().lastInjectionPreview = `${contract.slice(0, 1200)}${contract.length > 1200 ? '\n...[truncated]' : ''}`;
        log(`VIR contract injected IN_CHAT depth ${VIR_CONTRACT_DEPTH} | priority depth ${VIR_PRIORITY_DEPTH} (misses=${settings().consecutiveMisses||0})`);
    } catch (e) { warn('Contract injection failed', e); }
}
function clearVirContract() {
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        setExtensionPrompt('FF4_VIR_CONTRACT', '', POSITION_IN_CHAT, VIR_CONTRACT_DEPTH);
        setExtensionPrompt('FF4_VIR_STATE', '', POSITION_IN_CHAT, VIR_STATE_DEPTH);
        setExtensionPrompt('FF4_VIR_PRIORITY', '', POSITION_IN_CHAT, VIR_PRIORITY_DEPTH);
    } catch { /* ignore */ }
}

/**
 * Build the dynamic VIR state context for injection at system-prompt level.
 * Mirrors RPG HUD's buildContext() — formatted, readable summary of the
 * CURRENT world state that the AI references when generating its reply.
 */
async function buildVirStateText() {
    const worldName = currentWorldName();
    if (!worldName) return '';
    let data;
    try { data = await loadWorldInfo(worldName); } catch { return ''; }
    if (!data) return '';

    const allChars = characterEntries(data);

    const lines = ['=== VIR WORLD STATE ==='];

    const userName = canonicalizeName(String(name1 || '')).canonical;
    const userEntry = userName ? allChars.find(([, entry]) => characterEntryName(entry) === userName)?.[1] : null;
    const userVir = userEntry ? parseActiveVir(userEntry.content || '') : {};
    const activePersonaText = String(power_user?.persona_description || '').trim();
    if (userName && (!userEntry || isWeakUserVir(userVir))) {
        lines.push('[USER VIR REPAIR NEEDED]');
        lines.push(`User character name: ${userName}`);
        if (activePersonaText) {
            lines.push('Use active persona description plus current card/scenario/story evidence to create or update this user VIR.');
        } else {
            lines.push('Active persona description is empty. Create or update this user VIR from current card, scenario, first message, and visible story/chat evidence only.');
        }
        lines.push('Do not use other saved personas, unrelated chats, or memory from other sessions.');
        lines.push('Emit a schema 3 characters[] create/update for the user this turn with full visual fields: species, age_appearance, height, build, hair, eyes, skin_fur_scales, face_features, body, outfit, accessories, pose, expression, location_context.');
        lines.push('If exact clothing is not stated, infer the most plausible current outfit from the current scene and keep it stable until the story changes it.');
        lines.push('[/USER VIR REPAIR NEEDED]');
    }

    const promptLockNames = allChars
        .filter(([, entry]) => entry?.constant !== false)
        .map(([, entry]) => characterEntryName(entry))
        .filter(Boolean);
    if (promptLockNames.length) {
        lines.push('[VIR PROMPT LOCK]');
        lines.push(`Character block order for <pic> prompts: ${promptLockNames.join(' -> ')}`);
        lines.push('Do not reshuffle this order on retries unless the prose explicitly gives a new left/right layout.');
        lines.push('Use physical positions from position/location/pose first: behind counter, in front of counter, doorway, background, beside bed. Do not invent left/right when a better physical slot exists.');
        lines.push('Use the ACTIVE VIR fields as the visual identity source; keep the canonical "Full Name from Full Source Name" or "Full Name, an original character" wording intact. Only pose, expression, and condition may change when the current beat changes.');
        lines.push('[/VIR PROMPT LOCK]');
    }

    // Character cards (compact one-block per char)
    for (const [, entry] of allChars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        const vir = parseActiveVir(entry.content || '');
        const card = [
            `  ${name}:`,
            `    pic_identity: ${buildPicIdentity(name, vir) || name}`,
            vir.species ? `    species: ${vir.species}` : '',
            vir.source ? `    source: ${vir.source}` : '',
            vir.age_appearance ? `    age: ${vir.age_appearance}` : '',
            vir.height ? `    height: ${vir.height}` : '',
            vir.build ? `    build: ${vir.build}` : '',
            vir.hair ? `    hair: ${vir.hair}` : '',
            vir.hair_state ? `    hair_now: ${vir.hair_state}` : '',
            vir.eyes ? `    eyes: ${vir.eyes}` : '',
            vir.skin_fur_scales ? `    skin: ${vir.skin_fur_scales}` : '',
            vir.face_features ? `    face: ${vir.face_features}` : '',
            vir.body ? `    body: ${vir.body}` : '',
            vir.marks ? `    marks: ${vir.marks}` : '',
            Array.isArray(vir.outfit) && vir.outfit.length ? `    outfit: ${vir.outfit.join('; ')}` : '',
            Array.isArray(vir.accessories) && vir.accessories.length ? `    accessories: ${vir.accessories.join('; ')}` : '',
            vir.pose ? `    pose: ${vir.pose}` : '',
            vir.expression ? `    expression: ${vir.expression}` : '',
            vir.condition ? `    condition: ${vir.condition}` : '',
            vir.location_context ? `    position: ${vir.location_context}` : '',
            vir.voice_lock?.dialogue_color ? `    dialogue_color: ${vir.voice_lock.dialogue_color}` : '',
        ].filter(Boolean);
        lines.push(...card);
    }

    // Recall window
    const st = settings();
    const recall = st.recallCharacters?.[worldName];
    if (recall && Object.keys(recall).length) {
        const bits = Object.entries(recall).map(([n, t]) => `${n}(${t}t)`);
        lines.push(`[RECALL WINDOW] ${bits.join(', ')}`);
    }

    lines.push('=== END VIR STATE ===');
    return lines.join('\n');
}

/**
 * Refresh the dynamic VIR state injection. IN_CHAT depth 2 — fresher than the
 * static contract (depth 4) because state changes every turn and needs the
 * AI to consult it just before responding.
 */
async function injectVirState() {
    if (!settings().enabled || !settings().contractInjection) return;
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        const text = await buildVirStateText();
        if (!text) {
            setExtensionPrompt('FF4_VIR_STATE', '', POSITION_IN_CHAT, VIR_STATE_DEPTH);
            return;
        }
        setExtensionPrompt('FF4_VIR_STATE', text, POSITION_IN_CHAT, VIR_STATE_DEPTH, false, 'system');
        settings().lastInjectionPreview = `${text.slice(0, 1200)}${text.length > 1200 ? '\n...[truncated]' : ''}`;
        log(`VIR state injected IN_CHAT depth ${VIR_STATE_DEPTH}`);
    } catch (e) { warn('State injection failed', e); }
}

// ============================================================================
// PROCESS SYNC PACKET — apply state to lorebook
// ============================================================================
async function processSyncPacket(sync) {
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
    ensureFF4StateEntry(data);

    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    await activateCurrentWorld();
    await injectVirState();

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
    if (!settings().enabled) return;
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
                    st.consecutiveMisses = (st.consecutiveMisses || 0) + 1;
                    st.totalMisses = (st.totalMisses || 0) + 1;
                    warn(`VIR miss #${st.consecutiveMisses} (total ${st.totalMisses}) — escalating depth-1 reminder`);
                }
            }
            saveSettingsDebounced();
            // Re-inject contract + escalated priority for the NEXT turn
            injectVirContract();
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
    if (!settings().enabled) return;
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
    if (!settings().enabled) return;
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
    let changed = false;
    for (const name of Object.keys(recall)) {
        recall[name]--;
        if (recall[name] <= 0) { delete recall[name]; changed = true; }
    }
    if (changed) {
        saveSettingsDebounced();
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
            const st = settings();
            st.pinnedCharacters = st.pinnedCharacters || {};
            st.pinnedCharacters[worldName] = st.pinnedCharacters[worldName] || [];
            if (!st.pinnedCharacters[worldName].includes(canonical)) st.pinnedCharacters[worldName].push(canonical);
            saveSettingsDebounced();
            await reapplyTiers();
            return `Pinned ${canonical} (Tier A, always active).`;
        };
        const park = async (args, value) => {
            const name = String(value || '').trim();
            if (!name) return 'Usage: /vir-park <Name>';
            const worldName = currentWorldName();
            if (!worldName) return 'No active chat.';
            const canonical = canonicalizeName(name).canonical;
            const st = settings();
            if (st.pinnedCharacters?.[worldName]) {
                st.pinnedCharacters[worldName] = st.pinnedCharacters[worldName].filter(n => n !== canonical);
            }
            if (st.recallCharacters?.[worldName]) {
                delete st.recallCharacters[worldName][canonical];
            }
            saveSettingsDebounced();
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
                let tier = entry.constant ? (pinned.has(name) ? '[PIN]' : (recall[name] ? `[RECALL:${recall[name]}t]` : '[ACT]')) : '[OFF]';
                lines.push(`  ${tier} ${name}`);
            }
            return lines.join('\n');
        };
        const status = async () => {
            const worldName = currentWorldName();
            const st = settings();
            const lines = [
                `FF4 VIR v${VERSION}`,
                `Enabled: ${st.enabled}`,
                `Smart tiers: ${st.smartTiers !== false}`,
                `Contract injection: ${st.contractInjection !== false}`,
                `Current world: ${worldName || 'none'}`,
                `Session packets: ${sessionPacketCount}`,
                `Last sync: ${st.lastSyncStatus}`,
            ];
            return lines.join('\n');
        };
        const sheetDirective = (kind, rawName) => {
            const name = canonicalizeName(String(rawName || '').trim()).canonical;
            if (!name) return `Usage: /vir${kind} <Name>`;
            const mode = settings().sheetCommandMode || settings().templateMode || 'Detailed';
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
    const snapshot = {
        version: VERSION,
        chatId: getCurrentChatId?.() || '',
        worldName,
        enabled: !!st.enabled,
        contractInjection: st.contractInjection !== false,
        templateMode: st.templateMode || 'Detailed',
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
            const reason = pinned.has(name) ? 'pinned'
                : recall[name] ? `recall ${recall[name]} turns`
                : constant ? 'active/constant'
                : 'offscreen keyword-only';
            snapshot.characters.push({
                name,
                tier: pinned.has(name) ? 'PIN' : recall[name] ? 'RCL' : constant ? 'ACT' : 'OFF',
                reason,
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
            const tier = pinned.has(name) ? 'PIN' : recall[name] ? 'RCL' : constant ? 'ACT' : 'OFF';
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
                    <label class="ff4-vir-tog" title="Smart tiers: only scene-active + pinned + recalled chars inject as constant. Offscreen chars are keyword-only (zero token cost until name appears in chat)."><input id="ff4_vir_smart_tiers" type="checkbox"> <span>Smart dynamic tiers (recommended)</span></label>
                    <label class="ff4-vir-tog" title="Strip the AI's emitted vir packet from the visible chat so prose stays clean."><input id="ff4_vir_auto_hide" type="checkbox"> <span>Auto-hide synced packets</span></label>
                    <label class="ff4-vir-tog" title="Inject the VIR contract + current world state into every generation. Like RPG HUD — no preset edit needed."><input id="ff4_vir_contract" type="checkbox"> <span>Auto-inject contract + state</span></label>

                    <label class="ff4-vir-tog" title="Auto-create a pinned VIR entry from your active persona description so {{user}} is tracked alongside NPCs. The AI never emits a vir packet for the user — this bridges that gap."><input id="ff4_vir_seed_user" type="checkbox"> <span>Track user persona ({{user}})</span></label>

                    <div class="ff4-vir-mode-row">
                        <label for="ff4_vir_template_mode"><b>Template mode</b></label>
                        <select id="ff4_vir_template_mode" class="text_pole widthNatural">
                            <option value="Compact">Compact</option>
                            <option value="Detailed">Detailed</option>
                            <option value="VN Director">VN Director</option>
                            <option value="Image Heavy">Image Heavy</option>
                        </select>
                    </div>

                    <details class="ff4-vir-advanced">
                        <summary>Advanced</summary>
                        <label class="ff4-vir-tog" title="Show injection diagnostics and copyable debug reports."><input id="ff4_vir_diagnostics" type="checkbox"> <span>Diagnostics panel</span></label>
                        <label class="ff4-vir-tog" title="Store the VIR lorebook reference in chat metadata so it re-activates automatically when you reopen this chat."><input id="ff4_vir_bind_to_chat" type="checkbox"> <span>Bind lorebook to current chat</span></label>
                        <label class="ff4-vir-tog" title="When a chat is deleted, also delete its VIR lorebook so orphaned lorebooks don't pile up."><input id="ff4_vir_cleanup_delete" type="checkbox"> <span>Delete VIR lorebook when chat deleted</span></label>
                        <label class="ff4-vir-tog" title="Verbose console logging + toasts for troubleshooting."><input id="ff4_vir_debug" type="checkbox"> <span>Debug logging</span></label>
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
                        <button id="ff4_vir_refresh" class="menu_button">⟳ Refresh</button>
                        <button id="ff4_vir_copy_debug" class="menu_button">Copy Debug</button>
                        <button id="ff4_vir_clear_warn" class="menu_button">Clear</button>
                        <button id="ff4_vir_export" class="menu_button">⬇ Export</button>
                        <label for="ff4_vir_import" class="menu_button">⬆ Import</label>
                        <input id="ff4_vir_import" type="file" accept="application/json" style="display:none">
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
        if (settings().enabled) await activateCurrentWorld();
        else clearVirContract();
    });
    wire('ff4_vir_auto_hide', 'autoHideSyncedPackets');
    wire('ff4_vir_smart_tiers', 'smartTiers', async () => { await reapplyTiers(); });
    wire('ff4_vir_contract', 'contractInjection', () => {
        if (settings().contractInjection) injectVirContract();
        else clearVirContract();
    });
    const templateModeEl = $('ff4_vir_template_mode');
    if (templateModeEl) {
        templateModeEl.value = settings().templateMode || 'Detailed';
        templateModeEl.addEventListener('change', function () {
            settings().templateMode = this.value;
            saveSettingsDebounced();
            if (settings().contractInjection) injectVirContract();
            updateStatus();
        });
    }
    wire('ff4_vir_seed_user', 'seedUserPersona', async () => { if (settings().seedUserPersona) await activateCurrentWorld(); });
    wire('ff4_vir_diagnostics', 'diagnosticsEnabled', updateStatus);
    wire('ff4_vir_bind_to_chat', 'bindToChat', async () => { if (settings().bindToChat) await activateCurrentWorld(); });
    wire('ff4_vir_cleanup_delete', 'cleanupOnChatDelete');
    wire('ff4_vir_debug', 'debug');

    $('ff4_vir_activate')?.addEventListener('click', async () => {
        await activateCurrentWorld();
        updateStatus();
        renderCharacterList();
    });
    $('ff4_vir_refresh')?.addEventListener('click', () => { updateStatus(); renderCharacterList(); });
    $('ff4_vir_copy_debug')?.addEventListener('click', copyVirDebugReport);
    $('ff4_vir_clear_warn')?.addEventListener('click', () => {
        settings().recentWarnings = [];
        saveSettingsDebounced();
        updateStatus();
    });
    $('ff4_vir_export')?.addEventListener('click', exportCurrentVir);
    $('ff4_vir_import')?.addEventListener('change', function () { importVirFile(this.files?.[0]); this.value = ''; });
    $('ff4_vir_reset')?.addEventListener('click', resetCurrentChatVir);

    updateStatus();
}

async function updateStatus() {
    const worldName = currentWorldName();
    const setEl = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setEl('ff4_vir_current_world', worldName || 'No active chat');
    setEl('ff4_vir_last_sync', settings().lastSyncStatus || 'No sync yet');
    setEl('ff4_vir_session_count', String(sessionPacketCount));

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
                <div><b>Mode:</b> ${escapeHtml(snap.templateMode)} · <b>Depths:</b> contract ${VIR_CONTRACT_DEPTH}, state ${VIR_STATE_DEPTH}, priority ${VIR_PRIORITY_DEPTH}</div>
                <div><b>Misses:</b> streak ${escapeHtml(snap.missStreak)}, total ${escapeHtml(snap.totalMisses)} · <b>Tokens:</b> ${escapeHtml(snap.tokenEstimate)}</div>
                <div><b>Last injection:</b><pre style="white-space:pre-wrap;max-height:120px;overflow:auto;">${escapeHtml(settings().lastInjectionPreview || 'No injection preview yet.')}</pre></div>
                <div>${rows}</div>`;
        }
    }

    await renderCharacterList();
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
    const pinned = new Set(st.pinnedCharacters?.[worldName] || []);
    const recall = st.recallCharacters?.[worldName] || {};
    const rows = [];
    for (const [, entry] of chars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        let tier, tierColor;
        if (pinned.has(name)) { tier = 'PIN'; tierColor = '#FFD180'; }
        else if (entry.constant && recall[name]) { tier = `RCL${recall[name]}`; tierColor = '#B39DDB'; }
        else if (entry.constant) { tier = 'ACT'; tierColor = '#A5D6A7'; }
        else { tier = 'OFF'; tierColor = '#aab4c0'; }
        const vir = parseActiveVir(entry.content || '');
        const color = vir?.voice_lock?.dialogue_color || '';
        rows.push(`<div class="ff4-vir-char-row">
            <span class="ff4-vir-char-tier" style="color:${tierColor}">[${tier}]</span>
            <span class="ff4-vir-char-name">${escapeHtml(name)}</span>
            ${color ? `<span style="color:${color};font-weight:600">●</span>` : ''}
            <button class="ff4-vir-pin-btn menu_button" data-name="${escapeHtml(name)}" data-action="${pinned.has(name) ? 'park' : 'pin'}">${pinned.has(name) ? 'Unpin' : 'Pin'}</button>
        </div>`);
    }
    container.innerHTML = rows.join('');
    container.querySelectorAll('.ff4-vir-pin-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.getAttribute('data-name');
            const action = btn.getAttribute('data-action');
            const worldName = currentWorldName();
            if (!worldName || !name) return;
            const st = settings();
            st.pinnedCharacters = st.pinnedCharacters || {};
            st.pinnedCharacters[worldName] = st.pinnedCharacters[worldName] || [];
            if (action === 'pin') {
                if (!st.pinnedCharacters[worldName].includes(name)) st.pinnedCharacters[worldName].push(name);
            } else {
                st.pinnedCharacters[worldName] = st.pinnedCharacters[worldName].filter(n => n !== name);
            }
            saveSettingsDebounced();
            await reapplyTiers();
            updateStatus();
        });
    });
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
    if (!confirm('Reset all VIR data for current chat? This deletes the lorebook.')) return;
    const worldName = currentWorldName();
    if (!worldName) return;
    await deleteVirWorld(worldName);
    await updateWorldInfoList();
    toastr.info('Chat VIR reset.', 'FF4 VIR');
    updateStatus();
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
jQuery(async () => {
    settings();
    renderSettings();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        await activateCurrentWorld();
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

    // Re-apply colours on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (settings().dialogueColorEnabled) setTimeout(applyDialogueColors, 200);
    });

    registerSlashCommands();
    await activateCurrentWorld();
    log(`v${VERSION} initialized (RPG-HUD-aligned event model)`);
});

// ── v5.5 dialogue colour CSS application ────────────────────────────────────
// Reads voice_lock.dialogue_color for each character in the current chat's VIR
// world and applies the colour to that character's .name_text label in chat DOM.
// Pure DOM styling — no markdown injection, no message mutation.
async function getDialogueColorMap() {
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
