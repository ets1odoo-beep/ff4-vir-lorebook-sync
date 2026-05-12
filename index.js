import { extension_settings, getContext } from '../../../extensions.js';
import {
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    saveSettingsDebounced,
    updateMessageBlock,
} from '../../../../script.js';
import {
    getWorldInfoSettings,
    deleteWorldInfo,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    updateWorldInfoSettings,
    world_names,
} from '../../../world-info.js';

const EXT = 'ff4-vir-lorebook-sync';
const WORLD_PREFIX = 'FF4 VIR - ';
const OLD_WORLD_NAMES = new Set(['FF4 VIR Registry']);
const SYNC_RE = /<vir_sync\b[^>]*>([\s\S]*?)<\/vir_sync>/gi;
const REQUIRED_VIR_FIELDS = ['species', 'age_appearance', 'height', 'hair', 'eyes', 'skin_fur_scales', 'body', 'outfit'];
const WEAK_TEXT_RE = /\b(unknown|unspecified|generic|default|usual|same as before|same outfit|normal clothes|school uniform|formal attire|casual clothes|everyday clothes|long hair|short hair|medium hair|dark hair|light hair|black eyes|blue eyes|brown eyes|red eyes|green eyes|big breasts|large breasts|huge breasts|large cock|huge cock|huge dick|small breasts|average body|fit build|curvy figure|nice body|pretty face)\b/i;
const SCENARIO_NAME_SUFFIX_RE = /\s*(?:[-–—|:/\\()[\]{}]+|\b)(?:netori|ntr|netorare|roleplay|rp|scenario|story|plot|route|mode|au|alt|alternate|version|ver\.?|variant|outfit|costume|uniform|dress|casual|swimsuit|bikini|lingerie|school|college|office|maid|nurse|wife|mom|mother|aunt|sister|niece|girlfriend|isekai|rpg|vn)\b.*$/i;
const NAME_NOISE_RE = /\b(netori|ntr|netorare|roleplay|scenario|route|au|alt|variant|outfit|costume|mode|rpg|vn)\b/i;
const MAX_RECENT_WARNINGS = 12;

const defaultSettings = {
    enabled: true,
    debug: false,
    autoHideSyncedPackets: true,
    cleanupOnChatDelete: true,
    worldChatMap: {},
    lastSyncStatus: 'No sync yet',
    recentWarnings: [],
};

let isProcessing = false;

function settings() {
    extension_settings[EXT] = Object.assign({}, defaultSettings, extension_settings[EXT] || {});
    return extension_settings[EXT];
}

function log(...args) {
    if (settings().debug) console.log(`[${EXT}]`, ...args);
}

function toastInfo(message) {
    if (settings().debug) toastr.info(message, 'FF4 VIR Sync');
}

function uniqueClean(values) {
    return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function noteSyncStatus(message, warnings = []) {
    const state = settings();
    state.lastSyncStatus = message;
    if (warnings.length) {
        state.recentWarnings = [...uniqueClean(warnings), ...(state.recentWarnings || [])].slice(0, MAX_RECENT_WARNINGS);
    }
    saveSettingsDebounced();
    updateStatus();
}

function safeNamePart(value) {
    return String(value || 'chat')
        .replace(/\.[^/.]+$/, '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90) || 'chat';
}

function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

function currentWorldName() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const stableId = chat_metadata?.integrity || chatId;
    const suffix = hashString(stableId);
    const existing = (world_names || []).find(name => String(name).startsWith(WORLD_PREFIX) && String(name).endsWith(`-${suffix}`));
    return existing || `${WORLD_PREFIX}${safeNamePart(chatId)}-${suffix}`;
}

function isVirWorldName(name) {
    return String(name || '').startsWith(WORLD_PREFIX) || OLD_WORLD_NAMES.has(String(name || ''));
}

function rememberWorldChat(worldName, chatId = getCurrentChatId()) {
    if (!worldName || !chatId) return;
    const context = getContext();
    const avatar = context?.characters?.[context.characterId]?.avatar || null;
    settings().worldChatMap = settings().worldChatMap || {};
    settings().worldChatMap[worldName] = {
        chatId: String(chatId),
        integrity: chat_metadata?.integrity || null,
        avatar,
        updatedAt: Date.now(),
    };
    saveSettingsDebounced();
}

function matchingWorldsForChat(chatId) {
    const safeChat = safeNamePart(chatId);
    const mapped = settings().worldChatMap || {};
    return (world_names || []).filter(name => {
        if (!isVirWorldName(name)) return false;
        if (mapped[name]?.chatId === chatId) return true;
        return String(name).startsWith(`${WORLD_PREFIX}${safeChat}-`);
    });
}

function canonicalizeName(rawName, payload = null) {
    const original = String(rawName || '').replace(/\s+/g, ' ').trim();
    const vir = payload?.vir || payload || {};
    const explicit = String(payload?.canonical_name || vir?.canonical_name || vir?.name || '').replace(/\s+/g, ' ').trim();
    const source = String(vir?.source || vir?.franchise || payload?.source || payload?.franchise || '').trim();
    let canonical = explicit || original;
    const warnings = [];

    canonical = canonical
        .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (canonical) {
        const stripped = canonical.replace(SCENARIO_NAME_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
        if (stripped && stripped !== canonical) {
            warnings.push(`Name normalized: "${canonical}" -> "${stripped}"`);
            canonical = stripped;
        }
    }

    if (!canonical) canonical = original || 'Unknown';

    if (source && NAME_NOISE_RE.test(canonical)) {
        warnings.push(`Name "${canonical}" still contains scenario wording; check canonical identity for source "${source}".`);
    }

    const aliases = uniqueClean([
        original,
        explicit && explicit !== canonical ? explicit : '',
        ...(Array.isArray(payload?.aliases) ? payload.aliases : []),
        ...(Array.isArray(vir?.aliases) ? vir.aliases : []),
    ]).filter(alias => alias !== canonical);

    return { canonical, aliases, warnings };
}

function renameObjectKeys(object, nameMap) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
    const renamed = {};
    for (const [name, value] of Object.entries(object)) {
        renamed[nameMap.get(name) || name] = value;
    }
    return renamed;
}

function normalizeSyncPacket(sync) {
    const normalized = structuredClone(sync);
    const warnings = [];
    const nameMap = new Map();

    normalized.new_characters = {};
    for (const [name, payload] of Object.entries(sync.new_characters || {})) {
        const info = canonicalizeName(name, payload);
        const nextPayload = structuredClone(payload || {});
        nextPayload.aliases = uniqueClean([...(nextPayload.aliases || []), ...info.aliases]);
        if (normalized.new_characters[info.canonical]) {
            const oldPayload = normalized.new_characters[info.canonical];
            normalized.new_characters[info.canonical] = {
                ...nextPayload,
                aliases: uniqueClean([...(oldPayload.aliases || []), ...(nextPayload.aliases || [])]),
                vir: mergeVir(oldPayload.vir || oldPayload, nextPayload.vir || nextPayload),
            };
            warnings.push(`Merged duplicate packet names into "${info.canonical}".`);
        } else {
            normalized.new_characters[info.canonical] = nextPayload;
        }
        nameMap.set(name, info.canonical);
        warnings.push(...info.warnings);
    }

    normalized.vir_delta = {};
    for (const [name, delta] of Object.entries(sync.vir_delta || {})) {
        const existingPayload = sync.new_characters?.[name] || delta;
        const info = canonicalizeName(name, existingPayload);
        normalized.vir_delta[info.canonical] = delta;
        nameMap.set(name, info.canonical);
        warnings.push(...info.warnings);
    }

    if (normalized.scene_state && typeof normalized.scene_state === 'object') {
        normalized.scene_state.active_characters = uniqueClean(normalized.scene_state.active_characters || [])
            .map(name => {
                const info = canonicalizeName(name);
                nameMap.set(name, info.canonical);
                warnings.push(...info.warnings);
                return info.canonical;
            });
        for (const name of Object.keys(normalized.scene_state.characters || {})) {
            if (!nameMap.has(name)) {
                const info = canonicalizeName(name);
                nameMap.set(name, info.canonical);
                warnings.push(...info.warnings);
            }
        }
        normalized.scene_state.characters = renameObjectKeys(normalized.scene_state.characters, nameMap);
    }

    return { sync: normalized, warnings: uniqueClean(warnings) };
}

function getEntries(data) {
    data.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
    return data.entries;
}

function nextUid(data) {
    const entries = getEntries(data);
    const ids = Object.keys(entries).map(Number).filter(Number.isFinite);
    return ids.length ? Math.max(...ids) + 1 : 0;
}

function makeEntry({ uid, key, comment, content, constant = false, order = 100, depth = 2, role = 'system' }) {
    return {
        uid,
        key: Array.isArray(key) ? key.filter(Boolean) : [String(key || '')].filter(Boolean),
        keysecondary: [],
        comment,
        content,
        constant,
        selective: false,
        order,
        position: 0,
        disable: false,
        addMemo: true,
        group: constant ? 'VIR_SYSTEM' : 'VIR_CHARACTERS',
        groupOverride: false,
        groupWeight: 100,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        probability: 100,
        useProbability: true,
        depth,
        role,
        vectorized: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
    };
}

function schemaContent() {
    return `<ff4_vir_lorebook_rules>
The lorebook is the source of truth for visual identity.
Use [LOCKED VISUAL CARD: Name] first, then [ACTIVE VIR: Name] JSON as source data. Copy locked card lines verbatim into every <pic> that includes that character.
CANONICAL NAME LOCK: Character names must be actual canon/persona names only. Do not append scenario/card-title tags, genre labels, kink labels, route labels, mode words, outfit labels, location labels, or plot descriptors. Forbidden suffixes include Netori, NTR, Roleplay, Scenario, AU, Alt, version labels, outfit labels, and route labels unless literally part of the legal/name field. For canon characters write "Ymir from Attack on Titan", never "Ymir Netori from Attack on Titan".
Locked identity fields: species, source/franchise, age_appearance, height, hair, eyes, skin_fur_scales, body, non_human, marks, outfit, accessories, equipment.
Mutable scene state comes only from [VIR_SCENE_INDEX]: position, condition, hair_state, outfit_state, held_items, injuries, lighting, location, weather. Do not overwrite locked identity with temporary wet/torn/nude/injured state unless prose made it permanent.
If a visible character has no [ACTIVE VIR], create a <vir_sync> packet with new_characters.
New/changed VIR must be image-ready: exact hair length/style/texture/color/parting/bangs/ornaments; exact eyes/color/shape/gaze; exact body/skin/species traits; locked body/anatomy proportions when relevant (breast size, ass/hips, thighs, penis/cock size, balls, pussy/vulva/clit traits); outfit/accessories as full strings with exact color/material/cut/detail/condition.
If a locked field changes permanently, narrate it first, then emit a <vir_sync> packet with vir_delta.
Bad VIR wording to avoid: usual outfit, school uniform, normal clothes, same as before, dark hair, black eyes, big breasts, fit build, generic body, card-title name mashups, and scenario suffixes in character names.
Do not output full VIR rosters in normal prose.
</ff4_vir_lorebook_rules>`;
}

function sceneIndexContent(sceneState = {}) {
    return `[VIR_SCENE_INDEX]\n${JSON.stringify(sceneState || {}, null, 2)}\n[/VIR_SCENE_INDEX]`;
}

function compactValue(value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
    if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join('; ');
    if (typeof value === 'object') {
        return Object.entries(value)
            .filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length))
            .map(([k, v]) => `${k}=${compactValue(v)}`)
            .join(', ');
    }
    return String(value).trim();
}

function compactPiece(piece) {
    if (typeof piece === 'string') return piece.trim();
    if (!piece || typeof piece !== 'object') return '';
    const slot = piece.slot ? `${piece.slot}: ` : '';
    const main = [
        piece.exact_color_shade || piece.color || piece.color_shade,
        piece.material,
        piece.item_type || piece.type || piece.item,
        piece.cut_or_style || piece.cut || piece.style,
        piece.fit,
        piece.distinguishing_detail || piece.detail,
        piece.condition,
    ].filter(Boolean).join(' ');
    return `${slot}${main}`.trim();
}

function compactList(label, items) {
    if (!Array.isArray(items) || !items.length) return [];
    return items.map((item, index) => `${label}${index + 1}: ${compactPiece(item) || compactValue(item)}`).filter(line => !line.endsWith(': '));
}

function lockedVisualCard(name, vir = {}) {
    const skin = vir.skin_fur_scales || vir.skin || vir.fur || vir.scales;
    const anatomy = vir.anatomy || vir.genitals || vir.nsfw_anatomy;
    const lines = [
        `[LOCKED VISUAL CARD: ${name}]`,
        `IDENTITY: ${compactValue([vir.species || vir.species_class, vir.source || vir.franchise, vir.age_appearance, vir.height])}`,
        `HAIR: ${compactValue(vir.hair)}`,
        `EYES: ${compactValue(vir.eyes)}`,
        `SKIN/FUR/SCALES: ${compactValue(skin)}`,
        `BODY/ANATOMY: ${compactValue([vir.body, anatomy])}`,
        `NON-HUMAN: ${compactValue(vir.non_human || vir.limb_config)}`,
        `MARKS: ${compactValue(vir.marks)}`,
        ...compactList('OUTFIT ', vir.outfit),
        ...compactList('ACCESSORY ', vir.accessories),
        ...compactList('EQUIPMENT ', vir.equipment),
        `[/LOCKED VISUAL CARD]`,
    ].filter(line => !line.endsWith(': ') && !line.endsWith(': '));
    return lines.join('\n');
}

function characterContent(name, payload = {}) {
    const vir = payload.vir || payload;
    return `[ACTIVE VIR: ${name}]
Copy VERBATIM into every <pic> that includes ${name}. Do NOT paraphrase, simplify, recolor, resize, or omit fields. Use the LOCKED VISUAL CARD first; JSON below is source data.
${lockedVisualCard(name, vir)}
${JSON.stringify(vir || {}, null, 2)}
[/ACTIVE VIR]`;
}

function ensureBaseEntries(data, sceneState = null) {
    const entries = getEntries(data);
    let schemaEntry = Object.values(entries).find(x => x?.comment === 'FF4 VIR Rules');
    if (!schemaEntry) {
        const uid = nextUid(data);
        schemaEntry = makeEntry({
            uid,
            key: ['FF4_VIR_RULES'],
            comment: 'FF4 VIR Rules',
            content: schemaContent(),
            constant: true,
            order: 40,
            depth: 1,
        });
        entries[uid] = schemaEntry;
    } else {
        schemaEntry.content = schemaContent();
        schemaEntry.constant = true;
        schemaEntry.disable = false;
    }

    let sceneEntry = Object.values(entries).find(x => x?.comment === 'VIR_SCENE_INDEX');
    if (!sceneEntry) {
        const uid = nextUid(data);
        sceneEntry = makeEntry({
            uid,
            key: ['VIR_SCENE_INDEX'],
            comment: 'VIR_SCENE_INDEX',
            content: sceneIndexContent(sceneState || {}),
            constant: true,
            order: 45,
            depth: 1,
        });
        entries[uid] = sceneEntry;
    } else if (sceneState) {
        sceneEntry.content = sceneIndexContent(sceneState);
        sceneEntry.constant = true;
        sceneEntry.disable = false;
    }
}

async function ensureWorldLoaded(worldName) {
    let data = await loadWorldInfo(worldName);
    if (!data || typeof data !== 'object') data = { entries: {} };
    getEntries(data);
    ensureBaseEntries(data);
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    return data;
}

function mergeVir(oldVir, delta) {
    if (!oldVir || typeof oldVir !== 'object') return structuredClone(delta || {});
    const result = structuredClone(oldVir);
    for (const [key, value] of Object.entries(delta || {})) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeVir(result[key], value)
            : value;
    }
    return result;
}

function parseActiveVir(content) {
    const match = String(content || '').match(/\[ACTIVE VIR:[^\]]+\]\s*([\s\S]*?)\s*\[\/ACTIVE VIR\]/);
    if (!match) return {};
    const jsonMatch = match[1].match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    try {
        return JSON.parse(jsonMatch[0]);
    } catch {
        return {};
    }
}

function findCharacterEntry(data, name) {
    const entries = getEntries(data);
    const target = canonicalizeName(name).canonical.toLowerCase();
    return Object.values(entries).find(entry => {
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'VIR_SCENE_INDEX') return false;
        const entryName = String(entry.comment || '').replace(/^VIR:\s*/i, '');
        if (canonicalizeName(entryName).canonical.toLowerCase() === target) return true;
        if (String(entry.content || '').toLowerCase().includes(`[active vir: ${target}]`)) return true;
        return (entry.key || []).some(key => canonicalizeName(key).canonical.toLowerCase() === target);
    });
}

function upsertCharacter(data, name, payload, activeNames) {
    if (!name || !payload) return;
    const entries = getEntries(data);
    const nameInfo = canonicalizeName(name, payload);
    name = nameInfo.canonical;
    const aliases = uniqueClean([...(Array.isArray(payload.aliases) ? payload.aliases : []), ...nameInfo.aliases]);
    const vir = payload.vir || payload;
    const key = [...new Set([name, ...aliases].filter(Boolean))];
    let entry = findCharacterEntry(data, name);

    if (!entry) {
        const uid = nextUid(data);
        entry = makeEntry({
            uid,
            key,
            comment: `VIR: ${name}`,
            content: characterContent(name, { vir }),
            constant: activeNames.has(name),
            order: 70,
            depth: 2,
        });
        entries[uid] = entry;
    } else {
        entry.key = [...new Set([...(entry.key || []), ...key])];
        entry.comment = `VIR: ${name}`;
        entry.content = characterContent(name, { vir });
        entry.constant = activeNames.has(name);
        entry.disable = false;
    }
}

function applyDelta(data, name, delta, activeNames) {
    if (!name || !delta) return;
    name = canonicalizeName(name, delta).canonical;
    const current = findCharacterEntry(data, name);
    const oldVir = current ? parseActiveVir(current.content) : {};
    upsertCharacter(data, name, { vir: mergeVir(oldVir, delta) }, activeNames);
}

function setActiveFlags(data, activeNames) {
    for (const entry of Object.values(getEntries(data))) {
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'VIR_SCENE_INDEX') continue;
        const name = String(entry.comment || '').replace(/^VIR:\s*/, '');
        entry.constant = activeNames.has(name);
    }
}

function characterEntryName(entry) {
    const commentName = String(entry?.comment || '').replace(/^VIR:\s*/i, '').trim();
    if (commentName && commentName !== entry?.comment) return commentName;
    const match = String(entry?.content || '').match(/\[ACTIVE VIR:\s*([^\]]+)\]/i);
    return match?.[1]?.trim() || '';
}

function characterEntries(data) {
    return Object.entries(getEntries(data)).filter(([, entry]) => {
        if (!entry || entry.comment === 'FF4 VIR Rules' || entry.comment === 'VIR_SCENE_INDEX') return false;
        return Boolean(characterEntryName(entry));
    });
}

function characterCount(data) {
    return characterEntries(data).length;
}

function normalizeWorldData(data) {
    const entries = getEntries(data);
    const warnings = [];
    const seen = new Map();

    for (const [uid, entry] of characterEntries(data)) {
        const oldName = characterEntryName(entry);
        const vir = parseActiveVir(entry.content);
        const info = canonicalizeName(oldName, { vir, aliases: entry.key || [] });
        const canonical = info.canonical;
        warnings.push(...info.warnings);

        if (seen.has(canonical)) {
            const target = entries[seen.get(canonical)];
            const mergedVir = mergeVir(parseActiveVir(target.content), vir);
            target.key = uniqueClean([...(target.key || []), ...(entry.key || []), oldName, ...info.aliases, canonical]);
            target.comment = `VIR: ${canonical}`;
            if (Object.keys(mergedVir || {}).length) target.content = characterContent(canonical, { vir: mergedVir });
            target.constant = target.constant || entry.constant;
            delete entries[uid];
            warnings.push(`Merged duplicate VIR entry "${oldName}" into "${canonical}".`);
            continue;
        }

        seen.set(canonical, uid);
        entry.key = uniqueClean([canonical, ...(entry.key || []), ...info.aliases]);
        entry.comment = `VIR: ${canonical}`;
        if (Object.keys(vir || {}).length) {
            entry.content = characterContent(canonical, { vir });
        } else {
            entry.content = String(entry.content || '')
                .replace(/\[ACTIVE VIR:\s*[^\]]+\]/i, `[ACTIVE VIR: ${canonical}]`)
                .replace(/\[LOCKED VISUAL CARD:\s*[^\]]+\]/i, `[LOCKED VISUAL CARD: ${canonical}]`);
        }
        if (oldName !== canonical) warnings.push(`Renamed VIR entry "${oldName}" to "${canonical}".`);
    }

    let sceneEntry = Object.values(entries).find(x => x?.comment === 'VIR_SCENE_INDEX');
    const sceneMatch = String(sceneEntry?.content || '').match(/\[VIR_SCENE_INDEX\]\s*([\s\S]*?)\s*\[\/VIR_SCENE_INDEX\]/);
    if (sceneEntry && sceneMatch) {
        try {
            const sceneState = JSON.parse(sceneMatch[1] || '{}');
            const normalized = normalizeSyncPacket({ schema: 1, new_characters: {}, vir_delta: {}, scene_state: sceneState });
            sceneEntry.content = sceneIndexContent(normalized.sync.scene_state || {});
            warnings.push(...normalized.warnings);
        } catch (error) {
            warnings.push(`Could not normalize VIR_SCENE_INDEX: ${error.message}`);
        }
    }

    ensureBaseEntries(data);
    return uniqueClean(warnings);
}

function extractPackets(text) {
    const packets = [];
    let match;
    SYNC_RE.lastIndex = 0;
    while ((match = SYNC_RE.exec(String(text || ''))) !== null) {
        const raw = match[0];
        let body = match[1].trim();
        body = body.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
        packets.push({ raw, body });
    }
    return packets;
}

function parsePacket(packet) {
    const data = JSON.parse(packet.body);
    if (!data || typeof data !== 'object') throw new Error('VIR sync packet is not an object');
    if (data.schema !== 1) throw new Error('Unsupported VIR sync schema');
    return data;
}

function textValue(value) {
    if (Array.isArray(value)) return value.map(textValue).join(' ');
    if (value && typeof value === 'object') return Object.values(value).map(textValue).join(' ');
    return String(value ?? '').trim();
}

function assertDetailedField(name, field, value, minLength = 24) {
    const text = textValue(value);
    if (!text || text.length < minLength) {
        return `${name} VIR field "${field}" is short for stable image prompting`;
    }
    if (WEAK_TEXT_RE.test(text)) {
        return `${name} VIR field "${field}" uses weak/generic wording: ${text.slice(0, 80)}`;
    }
    return null;
}

function assertOutfit(name, outfit) {
    if (!Array.isArray(outfit) || !outfit.length) {
        return [`${name} VIR outfit should be a non-empty layer array`];
    }
    return outfit
        .map((layer, index) => assertDetailedField(name, `outfit[${index}]`, layer, 28))
        .filter(Boolean);
}

function assertImageReadyVir(name, payload) {
    const vir = payload?.vir || payload;
    if (!vir || typeof vir !== 'object') return [`${name} VIR is missing`];
    const nameInfo = canonicalizeName(name, payload);
    const source = vir.source || vir.franchise;
    const sourceText = textValue(source);
    const nameWarnings = [
        ...nameInfo.warnings,
        NAME_NOISE_RE.test(name) ? `${name} looks like a card/scenario title, not a canonical character name` : null,
        sourceText && WEAK_TEXT_RE.test(sourceText) ? `${nameInfo.canonical} source/franchise uses weak wording: ${sourceText.slice(0, 80)}` : null,
    ].filter(Boolean);
    const missing = [];
    for (const field of REQUIRED_VIR_FIELDS) {
        if (!(field in vir)) missing.push(`${nameInfo.canonical} VIR missing recommended field "${field}"`);
    }
    const warnings = [
        ...nameWarnings,
        ...missing,
        assertDetailedField(nameInfo.canonical, 'hair', vir.hair, 44),
        assertDetailedField(nameInfo.canonical, 'eyes', vir.eyes, 30),
        sourceText ? assertDetailedField(nameInfo.canonical, 'source/franchise', source, 4) : null,
        assertDetailedField(nameInfo.canonical, 'skin_fur_scales', vir.skin_fur_scales, 24),
        assertDetailedField(nameInfo.canonical, 'body', vir.body, 32),
        ...assertOutfit(nameInfo.canonical, vir.outfit),
    ].filter(Boolean);
    if (vir.non_human) {
        const warning = assertDetailedField(nameInfo.canonical, 'non_human', vir.non_human, 24);
        if (warning) warnings.push(warning);
    }
    if (Array.isArray(vir.accessories)) {
        vir.accessories.forEach((item, index) => {
            const warning = assertDetailedField(nameInfo.canonical, `accessories[${index}]`, item, 14);
            if (warning) warnings.push(warning);
        });
    }
    if (Array.isArray(vir.equipment)) {
        vir.equipment.forEach((item, index) => {
            const warning = assertDetailedField(nameInfo.canonical, `equipment[${index}]`, item, 14);
            if (warning) warnings.push(warning);
        });
    }
    return warnings;
}

function validateSyncPacket(sync) {
    const warnings = [];
    for (const [name, payload] of Object.entries(sync.new_characters || {})) {
        warnings.push(...assertImageReadyVir(name, payload));
    }
    for (const [name, delta] of Object.entries(sync.vir_delta || {})) {
        if (!delta || typeof delta !== 'object') throw new Error(`${name} vir_delta must be an object`);
        if ('hair' in delta) warnings.push(assertDetailedField(name, 'hair delta', delta.hair, 44));
        if ('eyes' in delta) warnings.push(assertDetailedField(name, 'eyes delta', delta.eyes, 30));
        if ('skin_fur_scales' in delta) warnings.push(assertDetailedField(name, 'skin_fur_scales delta', delta.skin_fur_scales, 24));
        if ('body' in delta) warnings.push(assertDetailedField(name, 'body delta', delta.body, 32));
        if ('non_human' in delta && delta.non_human) warnings.push(assertDetailedField(name, 'non_human delta', delta.non_human, 24));
        if ('outfit' in delta) warnings.push(...assertOutfit(name, delta.outfit));
    }
    return warnings.filter(Boolean);
}

function activeNamesFrom(sync) {
    const names = new Set();
    for (const name of Object.keys(sync.new_characters || {})) names.add(name);
    for (const name of Object.keys(sync.vir_delta || {})) names.add(name);
    for (const name of sync.scene_state?.active_characters || []) names.add(name);
    for (const name of Object.keys(sync.scene_state?.characters || {})) {
        if (sync.scene_state.characters[name]?.active !== false) names.add(name);
    }
    return names;
}

async function activateCurrentWorld() {
    if (!settings().enabled) return;
    const worldName = currentWorldName();
    if (!worldName) return;
    await ensureWorldLoaded(worldName);
    rememberWorldChat(worldName);
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(wiSettings.world_info?.globalSelect)
        ? wiSettings.world_info.globalSelect
        : [];
    const next = [...active.filter(name => !isVirWorldName(name)), worldName];
    updateWorldInfoSettings(wiSettings, [...new Set(next)]);
    updateStatus();
}

async function deleteVirWorld(worldName) {
    if (!isVirWorldName(worldName)) return false;
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(wiSettings.world_info?.globalSelect)
        ? wiSettings.world_info.globalSelect
        : [];
    updateWorldInfoSettings(wiSettings, active.filter(name => name !== worldName));
    const deleted = await deleteWorldInfo(worldName);
    if (deleted) {
        delete settings().worldChatMap?.[worldName];
        saveSettingsDebounced();
    }
    return deleted;
}

async function cleanupVirForDeletedChat(chatId) {
    if (!settings().cleanupOnChatDelete || !chatId) return;
    const matches = matchingWorldsForChat(String(chatId));
    if (!matches.length) return;
    let deleted = 0;
    for (const worldName of matches) {
        if (await deleteVirWorld(worldName)) deleted++;
    }
    if (deleted) toastr.info(`Deleted ${deleted} VIR lorebook(s) for removed chat.`, 'FF4 VIR Sync');
    await updateWorldInfoList();
    updateStatus();
}

async function cleanupCurrentCharacterOrphans() {
    const context = getContext();
    const character = context?.characters?.[context.characterId];
    if (!character?.avatar) return toastr.warning('No current character selected.', 'FF4 VIR Sync');
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar }),
    });
    if (!response.ok) return toastr.warning('Could not read current character chat list.', 'FF4 VIR Sync');
    const chats = Object.values(await response.json());
    const existingChatNames = new Set(chats.map(chat => String(chat.file_name || '').replace(/\.jsonl$/i, '')));
    const mapped = settings().worldChatMap || {};
    const candidates = (world_names || []).filter(name => {
        if (!String(name).startsWith(WORLD_PREFIX)) return false;
        const mappedChat = mapped[name]?.chatId;
        if (mappedChat) return !existingChatNames.has(mappedChat);
        const stem = String(name).slice(WORLD_PREFIX.length).replace(/-[a-z0-9]+$/i, '');
        return stem.startsWith(character.name) && !existingChatNames.has(stem);
    });
    if (!candidates.length) return toastr.info('No orphan VIR lorebooks found for current character.', 'FF4 VIR Sync');
    const ok = await context.Popup.show.confirm('Delete orphan VIR lorebooks?', `This deletes ${candidates.length} FF4 VIR lorebook(s) whose chat files are not listed for ${character.name}:\n\n${candidates.join('\n')}`);
    if (!ok) return;
    let deleted = 0;
    for (const worldName of candidates) {
        if (await deleteVirWorld(worldName)) deleted++;
    }
    await updateWorldInfoList();
    updateStatus();
    toastr.success(`Deleted ${deleted} orphan VIR lorebook(s).`, 'FF4 VIR Sync');
}

function deactivateVirWorlds() {
    const wiSettings = getWorldInfoSettings();
    const active = Array.isArray(wiSettings.world_info?.globalSelect)
        ? wiSettings.world_info.globalSelect
        : [];
    updateWorldInfoSettings(wiSettings, active.filter(name => !isVirWorldName(name)));
    updateStatus();
}

async function processSyncPacket(sync) {
    const worldName = currentWorldName();
    if (!worldName) throw new Error('No active chat id');
    const normalized = normalizeSyncPacket(sync);
    sync = normalized.sync;
    const data = await ensureWorldLoaded(worldName);
    const activeNames = activeNamesFrom(sync);

    ensureBaseEntries(data, sync.scene_state || {});
    for (const [name, payload] of Object.entries(sync.new_characters || {})) {
        upsertCharacter(data, name, payload, activeNames);
    }
    for (const [name, delta] of Object.entries(sync.vir_delta || {})) {
        applyDelta(data, name, delta, activeNames);
    }
    setActiveFlags(data, activeNames);

    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    await activateCurrentWorld();
    return { worldName, warnings: normalized.warnings };
}

async function handleMessage(messageId) {
    if (!settings().enabled || isProcessing) return;
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message || message.is_user || !message.mes?.includes('<vir_sync')) return;

    const packets = extractPackets(message.mes);
    if (!packets.length) return;
    const processed = new Set(message.extra?.[EXT]?.processed || []);

    isProcessing = true;
    try {
        const processedRaw = [];
        const allWarnings = [];
        let lastWorldName = '';
        for (const packet of packets) {
            const packetHash = hashString(packet.raw);
            if (processed.has(packetHash)) {
                continue;
            }
            const sync = parsePacket(packet);
            const preflight = normalizeSyncPacket(sync);
            const qualityWarnings = validateSyncPacket(preflight.sync);
            if (qualityWarnings.length) log('VIR quality warnings', qualityWarnings);
            const result = await processSyncPacket(preflight.sync);
            allWarnings.push(...preflight.warnings, ...qualityWarnings, ...(result.warnings || []));
            lastWorldName = result.worldName;
            processedRaw.push(packet.raw);
            log('Processed packet', preflight.sync);
        }

        if (!processedRaw.length) {
            return;
        }

        if (settings().autoHideSyncedPackets) {
            let updated = message.mes;
            for (const raw of processedRaw) updated = updated.replace(raw, '').replace(/\n{3,}/g, '\n\n').trim();
            message.mes = updated;
            updateMessageBlock(messageId, message);
            await context.saveChat();
        } else {
            message.extra = message.extra || {};
            message.extra[EXT] = message.extra[EXT] || {};
            message.extra[EXT].processed = [...new Set([...(message.extra[EXT].processed || []), ...processedRaw.map(hashString)])];
            await context.saveChat();
        }
        const uniqueWarnings = uniqueClean(allWarnings);
        noteSyncStatus(`Synced ${processedRaw.length} VIR packet(s)${lastWorldName ? ` to ${lastWorldName}` : ''}. ${uniqueWarnings.length ? `${uniqueWarnings.length} warning(s).` : 'No warnings.'}`, uniqueWarnings);
        if (uniqueWarnings.length) toastr.warning(`VIR synced with ${uniqueWarnings.length} quality warning(s). Check extension panel.`, 'FF4 VIR Sync');
        else toastInfo(`Synced ${processedRaw.length} VIR packet(s).`);
    } catch (error) {
        console.error(`[${EXT}] VIR sync failed`, error);
        noteSyncStatus(`VIR sync failed: ${error.message}`);
        toastr.warning(`VIR sync failed: ${error.message}`, 'FF4 VIR Sync');
    } finally {
        isProcessing = false;
    }
}

async function resetCurrentChatVir() {
    const worldName = currentWorldName();
    if (!worldName) return toastr.warning('No active chat.', 'FF4 VIR Sync');
    const ok = await getContext().Popup.show.confirm('Reset current chat VIR?', `This clears ${worldName} character VIR entries. Chat history is unchanged.`);
    if (!ok) return;
    const data = { entries: {} };
    ensureBaseEntries(data, {});
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    await activateCurrentWorld();
    toastr.success('Current chat VIR registry reset.', 'FF4 VIR Sync');
}

async function normalizeCurrentVirNames() {
    const worldName = currentWorldName();
    if (!worldName) return toastr.warning('No active chat.', 'FF4 VIR Sync');
    const data = await ensureWorldLoaded(worldName);
    const before = characterCount(data);
    const warnings = normalizeWorldData(data);
    await saveWorldInfo(worldName, data, true);
    await updateWorldInfoList();
    await activateCurrentWorld();
    const after = characterCount(data);
    noteSyncStatus(`Normalized ${worldName}. Characters: ${before} -> ${after}. ${warnings.length ? `${warnings.length} note(s).` : 'No changes.'}`, warnings);
    toastr.success(`Normalized current VIR lorebook (${before} -> ${after} characters).`, 'FF4 VIR Sync');
}

async function getCurrentWorldCharacterCount() {
    const worldName = currentWorldName();
    if (!worldName || !(world_names || []).includes(worldName)) return 0;
    try {
        const data = await loadWorldInfo(worldName);
        return characterCount(data || {});
    } catch {
        return 0;
    }
}

async function updateStatus() {
    const el = document.getElementById('ff4_vir_current_world');
    if (el) el.textContent = currentWorldName() || 'No active chat';
    const countEl = document.getElementById('ff4_vir_character_count');
    if (countEl) countEl.textContent = String(await getCurrentWorldCharacterCount());
    const syncEl = document.getElementById('ff4_vir_last_sync');
    if (syncEl) syncEl.textContent = settings().lastSyncStatus || 'No sync yet';
    const warningsEl = document.getElementById('ff4_vir_recent_warnings');
    if (warningsEl) {
        const warnings = settings().recentWarnings || [];
        warningsEl.innerHTML = warnings.length
            ? warnings.map(warning => `<div class="ff4-vir-warning">${String(warning).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))}</div>`).join('')
            : '<div class="ff4-vir-muted">No recent warnings.</div>';
    }
}

function renderSettings() {
    if (document.getElementById('ff4_vir_lorebook_sync_settings')) return;
    $('#extensions_settings').append(`
<div id="ff4_vir_lorebook_sync_settings" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>FF4 VIR Lorebook Sync</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="ff4-vir-row">
                <label for="ff4_vir_enabled">Enabled</label>
                <input id="ff4_vir_enabled" type="checkbox">
            </div>
            <div class="ff4-vir-help">Processes &lt;vir_sync&gt; packets after AI replies and stores visual identity in a per-chat lorebook.</div>
            <div class="ff4-vir-row">
                <label for="ff4_vir_auto_hide">Auto-hide synced packets</label>
                <input id="ff4_vir_auto_hide" type="checkbox">
            </div>
            <div class="ff4-vir-help">After a successful sync, removes the machine packet from the visible saved chat.</div>
            <div class="ff4-vir-row">
                <label for="ff4_vir_debug">Debug</label>
                <input id="ff4_vir_debug" type="checkbox">
            </div>
            <div class="ff4-vir-help">Shows extra console logs and success toasts. Leave off for normal RP.</div>
            <div class="ff4-vir-row">
                <label for="ff4_vir_cleanup_delete">Clean VIR when chat is deleted</label>
                <input id="ff4_vir_cleanup_delete" type="checkbox">
            </div>
            <div class="ff4-vir-help">Deletes the matching per-chat VIR lorebook after SillyTavern deletes that chat.</div>
            <div class="ff4-vir-status">
                <div>Current VIR lorebook: <span id="ff4_vir_current_world"></span></div>
                <div>Character entries: <span id="ff4_vir_character_count">0</span></div>
                <div>Last sync: <span id="ff4_vir_last_sync">No sync yet</span></div>
            </div>
            <div class="ff4-vir-audit">
                <b>Recent quality warnings</b>
                <div id="ff4_vir_recent_warnings"></div>
            </div>
            <div class="ff4-vir-buttons">
                <button id="ff4_vir_activate" class="menu_button">Activate Current Chat VIR</button>
                <button id="ff4_vir_normalize" class="menu_button">Normalize Current VIR Names</button>
                <button id="ff4_vir_cleanup_orphans" class="menu_button">Clean Orphan VIR Lorebooks</button>
                <button id="ff4_vir_reset" class="menu_button danger_button">Reset Current Chat VIR</button>
            </div>
        </div>
    </div>
</div>`);

    $('#ff4_vir_enabled').prop('checked', settings().enabled).on('change', async function () {
        settings().enabled = Boolean(this.checked);
        saveSettingsDebounced();
        if (settings().enabled) {
            await activateCurrentWorld();
        } else {
            deactivateVirWorlds();
        }
    });
    $('#ff4_vir_auto_hide').prop('checked', settings().autoHideSyncedPackets).on('change', function () {
        settings().autoHideSyncedPackets = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#ff4_vir_debug').prop('checked', settings().debug).on('change', function () {
        settings().debug = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#ff4_vir_cleanup_delete').prop('checked', settings().cleanupOnChatDelete).on('change', function () {
        settings().cleanupOnChatDelete = Boolean(this.checked);
        saveSettingsDebounced();
    });
    $('#ff4_vir_activate').on('click', activateCurrentWorld);
    $('#ff4_vir_normalize').on('click', normalizeCurrentVirNames);
    $('#ff4_vir_cleanup_orphans').on('click', cleanupCurrentCharacterOrphans);
    $('#ff4_vir_reset').on('click', resetCurrentChatVir);
    updateStatus();
}

jQuery(async () => {
    settings();
    renderSettings();
    eventSource.on(event_types.CHAT_CHANGED, activateCurrentWorld);
    eventSource.on(event_types.CHAT_DELETED, cleanupVirForDeletedChat);
    eventSource.on(event_types.GROUP_CHAT_DELETED, cleanupVirForDeletedChat);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessage);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    await activateCurrentWorld();
    log('initialized');
});
