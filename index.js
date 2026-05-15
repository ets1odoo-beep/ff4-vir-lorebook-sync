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
    saveMetadata,
    saveSettingsDebounced,
} from '../../../../script.js';
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
const VERSION = '5.1.1';
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
    recallTurnsDefault: 8,           // longer than v4 for better long-term memory
    worldChatMap: {},
    pinnedCharacters: {},
    recallCharacters: {},
    lastSyncStatus: 'No sync yet',
    lastSyncAt: 0,
    sessionPacketCount: 0,
    recentWarnings: [],
};
const MAX_RECENT_WARNINGS = 10;
let processingQueue = Promise.resolve();
let sessionPacketCount = 0;

// ============================================================================
// THE VIR CONTRACT — auto-injected as system prompt every generation
// ============================================================================
// Minimal contract — just the format directive the parser needs to recognise.
// All detailed rules (field conventions, color palette, FORBIDDEN/CORRECT,
// output order) live in the user's preset. Keep this under ~500 chars so it
// doesn't compete with preset content when injected at the chat tail.
const VIR_CONTRACT = `End every reply with one \`\`\`vir code-fence block as the absolute last thing in the message (after prose, <pic> tags, and any other tracker blocks). Single line of flat JSON, schema 3: {"schema":3,"characters":[{"name":"...","action":"create|update",...flat fields...}],"scene":{"location":"...","time":"...","active":"Name1,Name2"},"states":[{"name":"...","position":"...","aftermath":0}],"recall":[]}. Arrays of name-keyed flat objects only — never nested objects keyed by name, never nested voice_lock. Multi-piece outfit/accessories use SEMICOLON-separated strings.`;

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
function makeEntry({ uid, key, comment, content, constant = false, disable = false, order = 100, depth = 4, position = 4 }) {
    return {
        uid, key: Array.isArray(key) ? key : [key],
        keysecondary: [], comment: String(comment || ''),
        content: String(content || ''), constant, disable,
        order, depth, position, probability: 100, useProbability: true,
        addMemo: true, selective: true, group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: null, sticky: null, cooldown: null, delay: null,
    };
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

function lockedVisualCard(name, vir = {}) {
    const skin = vir.skin_fur_scales || vir.skin || vir.fur || vir.scales;
    const anatomy = vir.anatomy || vir.genitals || vir.nsfw_anatomy;
    const lines = [
        `[LOCKED VISUAL CARD: ${name}]`,
        `IDENTITY: ${compactValue([vir.species || vir.species_class, vir.source || vir.franchise, vir.age_appearance, vir.height])}`,
        `HAIR: ${compactValue(vir.hair)}`,
        `EYES: ${compactValue(vir.eyes)}`,
        `FACE_FEATURES: ${compactValue(vir.face_features || vir.face)}`,
        `BROW_LASH: ${compactValue(vir.brow_lash || vir.brows_lashes)}`,
        `LIPS_TEETH: ${compactValue(vir.lips_teeth || vir.lips)}`,
        `SKIN/FUR/SCALES: ${compactValue(skin)}`,
        `BODY/ANATOMY: ${compactValue([vir.body, anatomy])}`,
        `HANDS_FEET: ${compactValue(vir.hands_feet || vir.hands)}`,
        `POSTURE_VOICE: ${compactValue(vir.posture_voice || vir.voice)}`,
        `NON-HUMAN: ${compactValue(vir.non_human || vir.limb_config)}`,
        `MARKS: ${compactValue(vir.marks)}`,
        ...compactList('OUTFIT ', vir.outfit),
        ...compactList('UNDERWEAR ', vir.underwear),
        ...compactList('ACCESSORY ', vir.accessories),
        ...compactList('EQUIPMENT ', vir.equipment),
        vir.voice_lock?.dialogue_color ? `DIALOGUE_COLOR: ${vir.voice_lock.dialogue_color}` : '',
        `[/LOCKED VISUAL CARD]`,
    ].filter(line => line && !line.endsWith(': ') && !line.endsWith(':'));
    return lines.join('\n');
}

function characterContent(name, payload = {}) {
    const vir = payload.vir || payload;
    return `[ACTIVE VIR: ${name}]
Copy VERBATIM into every <pic> that includes ${name}. Do NOT paraphrase, simplify, recolor, resize, or omit fields.
${lockedVisualCard(name, vir)}
[/ACTIVE VIR]`;
}

function parseActiveVir(content) {
    const m = String(content || '').match(/\[ACTIVE VIR:[^\]]+\]\s*([\s\S]*?)\s*\[\/ACTIVE VIR\]/);
    if (!m) return {};
    return parseCardLines(m[1]);
}
function parseCardLines(body) {
    const vir = {};
    const cardMatch = body.match(/\[LOCKED VISUAL CARD:[^\]]+\]([\s\S]*?)\[\/LOCKED VISUAL CARD\]/);
    if (!cardMatch) return {};
    for (const line of cardMatch[1].split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const idx = t.indexOf(':');
        if (idx < 1) continue;
        const k = t.slice(0, idx).trim();
        const v = t.slice(idx + 1).trim();
        if (!v) continue;
        if (/^OUTFIT\s+\d+/i.test(k)) { (vir.outfit = vir.outfit || []).push(v); }
        else if (/^UNDERWEAR\s+\d+/i.test(k)) { (vir.underwear = vir.underwear || []).push(v); }
        else if (/^ACCESSORY\s+\d+/i.test(k)) { (vir.accessories = vir.accessories || []).push(v); }
        else if (/^EQUIPMENT\s+\d+/i.test(k)) { (vir.equipment = vir.equipment || []).push(v); }
        else if (k === 'HAIR') vir.hair = v;
        else if (k === 'EYES') vir.eyes = v;
        else if (k === 'FACE_FEATURES') vir.face_features = v;
        else if (k === 'BROW_LASH') vir.brow_lash = v;
        else if (k === 'LIPS_TEETH') vir.lips_teeth = v;
        else if (k === 'SKIN/FUR/SCALES') vir.skin_fur_scales = v;
        else if (k === 'BODY/ANATOMY') vir.body = v;
        else if (k === 'HANDS_FEET') vir.hands_feet = v;
        else if (k === 'POSTURE_VOICE') vir.posture_voice = v;
        else if (k === 'NON-HUMAN') vir.non_human = v;
        else if (k === 'MARKS') vir.marks = v;
        else if (k === 'DIALOGUE_COLOR') { vir.voice_lock = vir.voice_lock || {}; vir.voice_lock.dialogue_color = v; }
        else if (k === 'IDENTITY') {
            const parts = v.split(',').map(s => s.trim()).filter(Boolean);
            if (parts[0]) vir.species = parts[0];
            if (parts[1]) vir.source = parts[1];
            if (parts[2]) vir.age_appearance = parts[2];
            if (parts[3]) vir.height = parts[3];
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
        entry = makeEntry({
            uid, key, comment: `VIR: ${name}`, content: characterContent(name, { vir }),
            constant: false,  // tier system applies actual constant flag
            order: TIER.OFFSCREEN.order, depth: TIER.OFFSCREEN.depth, position: 4,
        });
        entries[uid] = entry;
    } else {
        entry.key = uniqueClean([...(entry.key || []), ...key]);
        entry.comment = `VIR: ${name}`;
        entry.content = characterContent(name, { vir });
        entry.disable = false;
    }
    return entry;
}

function applyDelta(data, name, delta) {
    if (!name || !delta) return;
    name = canonicalizeName(name, delta).canonical;
    const current = findCharacterEntry(data, name);
    const oldVir = current ? parseActiveVir(current.content) : {};
    return upsertCharacter(data, name, { vir: mergeVir(oldVir, delta) });
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
        entry = makeEntry({ uid, key: ['VIR_ROSTER'], comment: 'FF4 VIR Roster', content, constant: true, order: 43, depth: 1, position: 0 });
        entries[uid] = entry;
    } else if (content) {
        entry.content = content;
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
    await ensureWorldLoaded(worldName);
    rememberWorldChat(worldName);
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
const POSITION_IN_CHAT = 2;

function injectVirContract() {
    if (!settings().enabled || !settings().contractInjection) return;
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        // IN_CHAT depth 4 — sits 4 messages from the end of the chat stream
        // as a system reminder. Far enough from the user input that it acts
        // as background reference; close enough that the AI consults it.
        setExtensionPrompt('FF4_VIR_CONTRACT', VIR_CONTRACT, POSITION_IN_CHAT, VIR_CONTRACT_DEPTH, false, 'system');
        log(`VIR contract injected IN_CHAT depth ${VIR_CONTRACT_DEPTH}`);
    } catch (e) { warn('Contract injection failed', e); }
}
function clearVirContract() {
    try {
        const ctx = getContext();
        const setExtensionPrompt = ctx?.setExtensionPrompt || window.setExtensionPrompt;
        if (typeof setExtensionPrompt !== 'function') return;
        setExtensionPrompt('FF4_VIR_CONTRACT', '', POSITION_IN_CHAT, VIR_CONTRACT_DEPTH);
        setExtensionPrompt('FF4_VIR_STATE', '', POSITION_IN_CHAT, VIR_STATE_DEPTH);
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
    if (!allChars.length) return '';

    const lines = ['=== VIR WORLD STATE ==='];

    // Character cards (compact one-block per char)
    for (const [, entry] of allChars) {
        const name = characterEntryName(entry);
        if (!name) continue;
        const vir = parseActiveVir(entry.content || '');
        const card = [
            `  ${name}:`,
            vir.species ? `    species: ${vir.species}` : '',
            vir.hair ? `    hair: ${vir.hair}` : '',
            vir.eyes ? `    eyes: ${vir.eyes}` : '',
            vir.skin_fur_scales ? `    skin: ${vir.skin_fur_scales}` : '',
            vir.body ? `    body: ${vir.body}` : '',
            vir.marks ? `    marks: ${vir.marks}` : '',
            Array.isArray(vir.outfit) && vir.outfit.length ? `    outfit: ${vir.outfit.join('; ')}` : '',
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
    if (Array.isArray(sync.characters)) {
        for (const char of sync.characters) {
            if (!char || !char.name) continue;
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
    return { worldName, upserted: uniqueClean(upserted) };
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
            processedHashes.add(rawHash); processedHashes.add(packet.sig);
            processedRaw.push(packet.raw); // Collect raw for surgical stripping
            sessionPacketCount++;
            newPackets++;
        }
        message.extra[EXT].processed = [...processedHashes];

        if (newPackets || upsertedAll.size) {
            const upNote = upsertedAll.size ? ` (${[...upsertedAll].join(', ')})` : '';
            settings().sessionPacketCount = sessionPacketCount;
            noteSyncStatus(`Synced ${newPackets} VIR packet(s)${upNote}`);
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
async function registerSlashCommands() {
    try {
        const mod = await import('../../../slash-commands.js');
        const parser = mod.SlashCommandParser?.commands ? mod.SlashCommandParser : null;
        if (!parser) return;
        const reg = (name, callback, helpText) => {
            try {
                parser.addCommandObject?.({ name, callback, helpString: helpText });
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
        reg('vir-recall', recall, 'Recall a character for N turns. Usage: /vir-recall <Name>');
        reg('vir-pin',    pin,    'Pin a character to Tier A (always active). Usage: /vir-pin <Name>');
        reg('vir-park',   park,   'Unpin/clear recall. Usage: /vir-park <Name>');
        reg('vir-list',   list,   'List all VIR characters with their tier.');
        reg('vir-status', status, 'Show FF4 VIR extension status.');
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

                    <details class="ff4-vir-advanced">
                        <summary>Advanced</summary>
                        <label class="ff4-vir-tog"><input id="ff4_vir_bind_to_chat" type="checkbox"> <span>Bind lorebook to current chat</span></label>
                        <label class="ff4-vir-tog"><input id="ff4_vir_cleanup_delete" type="checkbox"> <span>Delete VIR lorebook when chat deleted</span></label>
                        <label class="ff4-vir-tog"><input id="ff4_vir_debug" type="checkbox"> <span>Debug logging</span></label>
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

                    <div class="ff4-vir-buttons">
                        <button id="ff4_vir_activate" class="menu_button" title="Force re-activate VIR lorebook in ST's Active Worlds list">⚓ Activate</button>
                        <button id="ff4_vir_refresh" class="menu_button">⟳ Refresh</button>
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
    wire('ff4_vir_bind_to_chat', 'bindToChat', async () => { if (settings().bindToChat) await activateCurrentWorld(); });
    wire('ff4_vir_cleanup_delete', 'cleanupOnChatDelete');
    wire('ff4_vir_debug', 'debug');

    $('ff4_vir_activate')?.addEventListener('click', async () => {
        await activateCurrentWorld();
        updateStatus();
        renderCharacterList();
    });
    $('ff4_vir_refresh')?.addEventListener('click', () => { updateStatus(); renderCharacterList(); });
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
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessageRendered);

    registerSlashCommands();
    await activateCurrentWorld();
    log(`v${VERSION} initialized (RPG-HUD-aligned event model)`);
});
