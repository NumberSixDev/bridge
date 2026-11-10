/* eslint-disable no-nested-ternary, no-restricted-syntax */

import { LeaderboardCategory, MetricDefinition, MetricUnit, ProfileSnapshot } from './types';

const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_SAFE_NUMBER
        ? value
        : undefined;
}

function safeKey(value: string) {
    return SAFE_KEY_PATTERN.test(value);
}

function humanise(value: string) {
    return value
        .replaceAll('_', ' ')
        .replaceAll('-', ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function atPath(profile: ProfileSnapshot, path: string[]) {
    let current: unknown = profile.profile;
    for (const part of path) {
        const record = object(current);
        if (!record) return undefined;
        current = record[part];
    }
    return current;
}

function directMetric(
    category: LeaderboardCategory,
    id: string,
    label: string,
    unit: MetricUnit,
    path: string[],
    key?: string,
    isDefault = false
): MetricDefinition {
    return {
        id,
        category,
        label,
        unit,
        default: isDefault,
        extract: (profile) => {
            const source = key === undefined ? atPath(profile, path) : atPath(profile, [...path]);
            if (key === undefined) return numberValue(source);
            const map = object(source);
            if (!map) return undefined;
            if (!Object.hasOwn(map, key)) return path.length ? 0 : undefined;
            return numberValue(map[key]);
        },
    };
}

function mappedMetric(
    category: LeaderboardCategory,
    id: string,
    label: string,
    unit: MetricUnit,
    mapPath: string[],
    key: string,
    isDefault = false
): MetricDefinition {
    return directMetric(category, id, label, unit, mapPath, key, isDefault);
}

function sumDirectMap(profile: ProfileSnapshot, path: string[]) {
    const source = object(atPath(profile, path));
    if (!source) return undefined;
    let total = 0;
    for (const value of Object.values(source)) {
        const number = numberValue(value);
        if (number === undefined) return undefined;
        total += number;
    }
    return numberValue(total);
}

function sumNestedKills(profile: ProfileSnapshot, path: string[]) {
    const source = object(atPath(profile, path));
    if (!source) return undefined;
    let total = 0;
    for (const entry of Object.values(source)) {
        const mob = object(entry);
        if (!mob) return undefined;
        const kills = Object.hasOwn(mob, 'kills') ? numberValue(mob.kills) : 0;
        if (kills === undefined) return undefined;
        total += kills;
    }
    return numberValue(total);
}

function sumKeysMatching(profile: ProfileSnapshot, path: string[], suffix: string) {
    const source = object(atPath(profile, path));
    if (!source) return undefined;
    let total = 0;
    for (const [key, value] of Object.entries(source)) {
        if (!key.endsWith(suffix)) continue;
        const number = Object.hasOwn(source, key) ? numberValue(value) : 0;
        if (number === undefined) return undefined;
        total += number;
    }
    return numberValue(total);
}

function sumNestedMap(profile: ProfileSnapshot, path: string[]) {
    const source = object(atPath(profile, path));
    if (!source) return undefined;
    let total = 0;
    for (const value of Object.values(source)) {
        const number = numberValue(value);
        if (number === undefined) return undefined;
        total += number;
    }
    return numberValue(total);
}

function sumRngKills(profile: ProfileSnapshot) {
    const source = object(profile.profile.rng_meters);
    if (!source) return undefined;
    let total = 0;
    for (const entry of Object.values(source)) {
        const meter = object(entry);
        if (!meter) return undefined;
        const kills = Object.hasOwn(meter, 'kills') ? numberValue(meter.kills) : 0;
        if (kills === undefined) return undefined;
        total += kills;
    }
    return numberValue(total);
}

function networthMetric(): MetricDefinition {
    return {
        id: 'networth',
        category: 'networth',
        label: 'Estimated networth',
        unit: 'amount',
        default: true,
        extract: (profile, networth) =>
            profile.inventoryHidden || networth?.hidden ? undefined : networth?.total,
    };
}

function purseMetric(): MetricDefinition {
    return {
        id: 'purse',
        category: 'purse',
        label: 'Purse',
        unit: 'amount',
        default: true,
        extract: (profile) => numberValue(profile.profile.coins),
    };
}

function collectionDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'collections.total',
            category: 'collections',
            label: 'Collections total',
            unit: 'count',
            default: true,
            extract: (profile) => sumDirectMap(profile, ['collections']),
        },
    ];
    const keys = new Set([
        'obsidian',
        'ender_stone',
        'summoning_eye',
        'crying_obsidian',
        'rough_amethyst',
        'null_ovoid',
    ]);
    for (const profile of profiles) {
        const source = object(profile.profile.collections);
        if (!source) continue;
        Object.keys(source)
            .filter(safeKey)
            .forEach((key) => keys.add(key));
    }
    for (const key of [...keys].sort()) {
        definitions.push(
            mappedMetric(
                'collections',
                `collections.${key}`,
                `${humanise(key)} collection`,
                'count',
                ['collections'],
                key
            )
        );
    }
    return definitions;
}

function skillDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'skills.total',
            category: 'skills',
            label: 'Skills XP total',
            unit: 'xp',
            default: true,
            extract: (profile) => sumDirectMap(profile, ['skills']),
        },
    ];
    const keys = new Set(['combat', 'mining', 'taming', 'catacombs']);
    for (const profile of profiles) {
        const source = object(profile.profile.skills);
        if (!source) continue;
        Object.keys(source)
            .filter(safeKey)
            .forEach((key) => keys.add(key));
    }
    for (const key of [...keys].sort()) {
        definitions.push(
            mappedMetric('skills', `skills.${key}`, `${humanise(key)} XP`, 'xp', ['skills'], key)
        );
    }
    return definitions;
}

function bestiaryDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'bestiary.total',
            category: 'bestiary',
            label: 'Bestiary kills total',
            unit: 'kills',
            default: true,
            extract: (profile) => sumNestedKills(profile, ['bestiary']),
        },
    ];
    const keys = new Set<string>();
    for (const profile of profiles) {
        const source = object(profile.profile.bestiary);
        if (!source) continue;
        Object.entries(source).forEach(([key, entry]) => {
            if (safeKey(key) && object(entry)) keys.add(key);
        });
    }
    for (const key of [...keys].sort()) {
        definitions.push({
            id: `bestiary.${key}.kills`,
            category: 'bestiary',
            label: `${humanise(key)} kills`,
            unit: 'kills',
            extract: (profile) => {
                const source = object(profile.profile.bestiary);
                if (!source) return undefined;
                if (!Object.hasOwn(source, key)) return 0;
                const entry = object(source[key]);
                if (!entry) return undefined;
                return Object.hasOwn(entry, 'kills') ? numberValue(entry.kills) : 0;
            },
        });
    }
    return definitions;
}

function slayerDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'slayer.total_xp',
            category: 'slayer',
            label: 'Slayer XP total',
            unit: 'xp',
            default: true,
            extract: (profile) => sumKeysMatching(profile, ['slayer'], '_xp'),
        },
    ];
    const keys = new Set<string>();
    for (const profile of profiles) {
        const source = object(profile.profile.slayer);
        if (!source) continue;
        Object.keys(source)
            .filter(safeKey)
            .forEach((key) => keys.add(key));
    }
    for (const key of [...keys].sort()) {
        const unit = key.endsWith('_xp') ? 'xp' : key.endsWith('_level') ? 'level' : 'count';
        definitions.push(
            mappedMetric(
                'slayer',
                `slayer.${key}`,
                `Slayer ${humanise(key)}`,
                unit,
                ['slayer'],
                key
            )
        );
    }
    return definitions;
}

function dungeonsDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'dungeons.completions_total',
            category: 'dungeons',
            label: 'Dungeon completions total',
            unit: 'count',
            default: true,
            extract: (profile) => sumNestedMap(profile, ['dungeons', 'completions']),
        },
    ];
    const directKeys = new Set(['secrets', 'zombie_kills', 'skeletor_kills']);
    const nestedKeys = new Map<string, Set<string>>([
        ['class_xp', new Set()],
        ['completions', new Set(['F7'])],
        ['best_score', new Set(['F7'])],
        ['essence', new Set()],
    ]);
    for (const profile of profiles) {
        const dungeons = object(profile.profile.dungeons);
        if (!dungeons) continue;
        Object.entries(dungeons).forEach(([key, value]) => {
            if (safeKey(key) && numberValue(value) !== undefined) directKeys.add(key);
        });
        for (const [mapName, keys] of nestedKeys) {
            const source = object(dungeons[mapName]);
            if (!source) continue;
            Object.keys(source)
                .filter(safeKey)
                .forEach((key) => keys.add(key));
        }
    }
    for (const key of [...directKeys].sort()) {
        const unit = key.includes('kill') ? 'kills' : key === 'secrets' ? 'count' : 'count';
        definitions.push(
            mappedMetric(
                'dungeons',
                `dungeons.${key}`,
                `Dungeons ${humanise(key)}`,
                unit,
                ['dungeons'],
                key
            )
        );
    }
    for (const [mapName, keys] of nestedKeys) {
        const unit: MetricUnit =
            mapName === 'class_xp' ? 'xp' : mapName === 'best_score' ? 'score' : 'count';
        for (const key of [...keys].sort()) {
            definitions.push(
                mappedMetric(
                    'dungeons',
                    `dungeons.${mapName}.${key}`,
                    `Dungeons ${humanise(mapName)} ${humanise(key)}`,
                    unit,
                    ['dungeons', mapName],
                    key
                )
            );
        }
    }
    return definitions;
}

function miningDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [];
    const directKeys = new Set(['tier', 'exp', 'core', 'ender', 'void', 'resets', 'tokens']);
    const nodeKeys = new Set<string>();
    for (const profile of profiles) {
        const hotd = object(profile.profile.hotd);
        if (!hotd) continue;
        Object.entries(hotd).forEach(([key, value]) => {
            if (safeKey(key) && numberValue(value) !== undefined) directKeys.add(key);
        });
        const nodes = object(hotd.nodes);
        if (nodes)
            Object.keys(nodes)
                .filter(safeKey)
                .forEach((key) => nodeKeys.add(key));
    }
    for (const key of [...directKeys].sort()) {
        const unit: MetricUnit = key === 'exp' ? 'xp' : key === 'tier' ? 'level' : 'count';
        definitions.push(
            mappedMetric(
                'mining',
                `mining.${key}`,
                `Heart of the Dragon ${humanise(key)}`,
                unit,
                ['hotd'],
                key,
                key === 'exp'
            )
        );
    }
    for (const key of [...nodeKeys].sort()) {
        definitions.push(
            mappedMetric(
                'mining',
                `mining.nodes.${key}`,
                `Mining node ${humanise(key)}`,
                'level',
                ['hotd', 'nodes'],
                key
            )
        );
    }
    return definitions;
}

function currencyDefinitions() {
    return [
        directMetric('currencies', 'currencies.motes', 'Motes', 'amount', [], 'motes', true),
        directMetric('currencies', 'currencies.bits', 'Bits', 'amount', [], 'bits'),
        directMetric(
            'currencies',
            'currencies.haunted_candy_earned',
            'Haunted candy earned',
            'count',
            [],
            'haunted_candy_earned'
        ),
        directMetric(
            'currencies',
            'currencies.dragon_essence',
            'Dragon essence',
            'count',
            [],
            'dragon_essence'
        ),
        directMetric(
            'currencies',
            'currencies.draconic_experience',
            'Draconic experience',
            'xp',
            [],
            'draconic_experience'
        ),
    ];
}

function statsDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [];
    const groups = ['base', 'additive', 'multiplicative', 'increase_max'] as const;
    for (const group of groups) {
        const keys = new Set<string>(group === 'base' ? ['health'] : []);
        for (const profile of profiles) {
            const stats = object(profile.profile.stats);
            const source = object(stats?.[group]);
            if (!source) continue;
            Object.keys(source)
                .filter(safeKey)
                .forEach((key) => keys.add(key));
        }
        for (const key of [...keys].sort()) {
            definitions.push(
                mappedMetric(
                    'stats',
                    `stats.${group}.${key}`,
                    `${humanise(group)} ${humanise(key)}`,
                    'stat',
                    ['stats', group],
                    key,
                    group === 'base' && key === 'health'
                )
            );
        }
    }
    return definitions;
}

function rngDefinitions(profiles: ProfileSnapshot[]) {
    const definitions: MetricDefinition[] = [
        {
            id: 'rng.total_kills',
            category: 'rng',
            label: 'RNG meter kills total',
            unit: 'kills',
            default: true,
            extract: (profile) => sumRngKills(profile),
        },
    ];
    const keys = new Set<string>();
    for (const profile of profiles) {
        const source = object(profile.profile.rng_meters);
        if (!source) continue;
        Object.entries(source).forEach(([key, entry]) => {
            if (safeKey(key) && object(entry)) keys.add(key);
        });
    }
    for (const key of [...keys].sort()) {
        definitions.push({
            id: `rng.${key}.kills`,
            category: 'rng',
            label: `${humanise(key)} meter kills`,
            unit: 'kills',
            extract: (profile) => {
                const source = object(profile.profile.rng_meters);
                if (!source) return undefined;
                if (!Object.hasOwn(source, key)) return 0;
                const meter = object(source[key]);
                if (!meter) return undefined;
                return Object.hasOwn(meter, 'kills') ? numberValue(meter.kills) : 0;
            },
        });
    }
    return definitions;
}

export function metricDefinitions(category: LeaderboardCategory, profiles: ProfileSnapshot[] = []) {
    switch (category) {
        case 'networth':
            return [networthMetric()];
        case 'purse':
            return [purseMetric()];
        case 'collections':
            return collectionDefinitions(profiles);
        case 'skills':
            return skillDefinitions(profiles);
        case 'bestiary':
            return bestiaryDefinitions(profiles);
        case 'slayer':
            return slayerDefinitions(profiles);
        case 'dungeons':
            return dungeonsDefinitions(profiles);
        case 'mining':
            return miningDefinitions(profiles);
        case 'currencies': {
            const definitions = currencyDefinitions();
            const discovered = new Set(definitions.map((definition) => definition.id));
            for (const profile of profiles) {
                for (const key of [
                    'motes',
                    'bits',
                    'haunted_candy_earned',
                    'dragon_essence',
                    'draconic_experience',
                ]) {
                    if (
                        Object.hasOwn(profile.profile, key) &&
                        !discovered.has(`currencies.${key}`)
                    ) {
                        discovered.add(`currencies.${key}`);
                    }
                }
            }
            return definitions;
        }
        case 'stats':
            return statsDefinitions(profiles);
        case 'rng':
            return rngDefinitions(profiles);
        default:
            return [];
    }
}

export function findMetricDefinition(
    category: LeaderboardCategory,
    requested: string | undefined,
    profiles: ProfileSnapshot[]
) {
    const definitions = metricDefinitions(category, profiles);
    if (!requested) return definitions.find((definition) => definition.default) ?? definitions[0];
    return definitions.find((definition) => definition.id === requested);
}

export function metricChoices(
    category: LeaderboardCategory,
    profiles: ProfileSnapshot[],
    query: string
) {
    const normalized = query.trim().toLowerCase();
    return metricDefinitions(category, profiles)
        .filter(
            (definition) =>
                !normalized ||
                definition.id.toLowerCase().includes(normalized) ||
                definition.label.toLowerCase().includes(normalized)
        )
        .slice(0, 25)
        .map((definition) => ({ name: definition.label.slice(0, 100), value: definition.id }));
}

export function isLeaderboardCategory(value: string): value is LeaderboardCategory {
    return [
        'networth',
        'purse',
        'collections',
        'skills',
        'bestiary',
        'slayer',
        'dungeons',
        'mining',
        'currencies',
        'stats',
        'rng',
    ].includes(value);
}
