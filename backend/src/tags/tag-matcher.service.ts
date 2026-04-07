import { Injectable } from '@nestjs/common';

export type TagMatcherMode = 'metric' | 'manual' | 'query';

export interface MatchableTag {
  id: string;
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
}

export interface TagMatchResult {
  tagId: string;
  score: number;
}

type TagSide = 'port' | 'starboard';

interface TagSearchProfile {
  tag: MatchableTag;
  side: TagSide | null;
  genericSingleToken: boolean;
  subcategoryPhrase: string;
  subcategoryTokens: string[];
  stemPhrase: string;
  stemTokens: string[];
  descriptionTokens: string[];
  exactPhrases: string[];
  synonymPhrases: string[];
}

interface SearchContext {
  normalized: string;
  tokens: Set<string>;
  sideHints: Set<TagSide>;
}

const GENERIC_SINGLE_TOKEN_ITEMS = new Set([
  'alarm',
  'camera',
  'controller',
  'converter',
  'display',
  'filter',
  'inverter',
  'monitor',
  'multiplexer',
  'pump',
  'receiver',
  'separator',
  'software',
  'switch',
  'tank',
  'transducer',
]);

const DESCRIPTION_TOKEN_STOP_WORDS = new Set([
  'and',
  'associated',
  'component',
  'components',
  'device',
  'driven',
  'equipment',
  'for',
  'inside',
  'main',
  'monitoring',
  'of',
  'onboard',
  'related',
  'side',
  'system',
  'systems',
  'the',
  'with',
]);

const ITEM_SYNONYMS: Record<string, string[]> = {
  adblue_system: ['adblue system', 'def dosing system', 'urea dosing system'],
  ais: ['automatic identification system'],
  battery_pack: ['house battery', 'service battery', 'battery bank'],
  bilge_alarm: ['bilge alarm'],
  day_tank: ['day tank', 'service tank', 'service fuel tank'],
  bottom_discrimination_sounder: [
    'bottom discrimination sounder',
    'sounder',
  ],
  bridge_navigational_watch_alarm_system: [
    'bnwas',
    'bridge watch alarm',
    'bridge navigational watch alarm system',
  ],
  ecdis: ['electronic chart display and information system'],
  echo_sounder: ['echo sounder', 'depth sounder'],
  emergency_generator: ['emergency generator', 'standby generator'],
  gnss: ['global navigation satellite system'],
  gps: ['global positioning system'],
  magnetic_compas: ['magnetic compass'],
  ocmd_monitor: [
    'ocmd',
    'oil content monitor',
    'oil content monitoring device',
    '15 ppm',
    '15ppm',
  ],
  oily_water_separator: [
    'oily water separator',
    'bilge water separator',
    'ows',
  ],
  satcom: ['vsat', 'inmarsat', 'iridium', 'satellite communications'],
  satellite_compass: ['satellite compass', 'gps compass'],
  shore_power: ['shore power'],
  shore_power_converter: ['shore power converter'],
  speed_log: ['speed log', 'knotmeter'],
  ssb: ['mf hf radio', 'single side band'],
  storage_tank: ['storage tank', 'fuel tank', 'fuel storage tank'],
  switchboard_emergency: ['emergency switchboard'],
  switchboard_main: ['main switchboard'],
  urea_tank: ['adblue tank', 'def tank', 'urea tank'],
  ups: ['uninterruptible power supply'],
  vhf: ['vhf radio'],
  weather_sensor: ['weather sensor', 'wind sensor'],
};

@Injectable()
export class TagMatcherService {
  rankTags(
    profiles: TagSearchProfile[],
    text: string,
    mode: TagMatcherMode,
    options?: { restrictToBestWindow?: boolean; limit?: number },
  ): TagMatchResult[] {
    const context = this.buildSearchContext(text);
    const threshold = mode === 'query' ? 9 : 7;
    const scored = profiles
      .map((profile) => ({
        tagId: profile.tag.id,
        score: this.scoreProfile(profile, context, mode),
      }))
      .filter((match) => match.score >= threshold)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      return [];
    }

    const limit = options?.limit ?? (mode === 'query' ? 8 : 12);
    if (options?.restrictToBestWindow === false) {
      return scored.slice(0, limit);
    }

    const bestScore = scored[0].score;
    const scoreWindow = mode === 'query' ? 1 : 2;

    return scored
      .filter((match) => bestScore - match.score <= scoreWindow)
      .slice(0, limit);
  }

  buildProfiles(tags: MatchableTag[]): TagSearchProfile[] {
    return tags.map((tag) => this.buildProfile(tag));
  }

  matchTags(
    profiles: TagSearchProfile[],
    text: string,
    mode: TagMatcherMode,
  ): TagMatchResult[] {
    return this.rankTags(profiles, text, mode);
  }

  private buildProfile(tag: MatchableTag): TagSearchProfile {
    const subcategoryPhrase = this.normalizeText(tag.subcategory);
    const subcategoryTokens = this.tokenize(subcategoryPhrase);
    const itemTokens = this.tokenize(this.normalizeText(tag.item));
    const lastItemToken = itemTokens[itemTokens.length - 1] ?? null;
    const side =
      lastItemToken === 'ps'
        ? 'port'
        : lastItemToken === 'sb'
          ? 'starboard'
          : null;
    const stemTokens = side ? itemTokens.slice(0, -1) : itemTokens;
    const stemPhrase = stemTokens.join(' ');
    const genericSingleToken =
      stemTokens.length === 1 &&
      GENERIC_SINGLE_TOKEN_ITEMS.has(stemTokens[0] ?? '');
    const descriptionTokens = [
      ...new Set(
        this.tokenize(this.normalizeText(tag.description ?? '')).filter(
          (token) =>
            token.length > 2 && !DESCRIPTION_TOKEN_STOP_WORDS.has(token),
        ),
      ),
    ];
    const exactPhrases = [
      ...(genericSingleToken || (side && stemTokens.length <= 1)
        ? []
        : [stemPhrase]),
      `${subcategoryPhrase} ${stemPhrase}`.trim(),
      this.normalizeText(tag.key.replace(/:/g, ' ')),
    ].filter(Boolean);
    const synonymPhrases = [
      ...(ITEM_SYNONYMS[tag.item] ?? []),
      ...(side === 'port'
        ? [
            stemPhrase ? `port ${stemPhrase}` : '',
            stemPhrase ? `port side ${stemPhrase}` : '',
            stemPhrase ? `${stemPhrase} port` : '',
          ]
        : []),
      ...(side === 'starboard'
        ? [
            stemPhrase ? `starboard ${stemPhrase}` : '',
            stemPhrase ? `starboard side ${stemPhrase}` : '',
            stemPhrase ? `${stemPhrase} starboard` : '',
          ]
        : []),
    ]
      .map((phrase) => this.normalizeText(phrase))
      .filter(Boolean);

    return {
      tag,
      side,
      genericSingleToken,
      subcategoryPhrase,
      subcategoryTokens,
      stemPhrase,
      stemTokens,
      descriptionTokens,
      exactPhrases,
      synonymPhrases,
    };
  }

  private scoreProfile(
    profile: TagSearchProfile,
    context: SearchContext,
    mode: TagMatcherMode,
  ): number {
    const hasSubcategory =
      profile.subcategoryTokens.length > 0 &&
      profile.subcategoryTokens.every((token) => context.tokens.has(token));
    const hasStemTokens =
      profile.stemTokens.length > 0 &&
      profile.stemTokens.every((token) => context.tokens.has(token));
    const descriptionMatchCount = profile.descriptionTokens.filter((token) =>
      context.tokens.has(token),
    ).length;
    const hasDescriptionSupport = descriptionMatchCount >= 2;
    const exactPhraseMatch = profile.exactPhrases.some((phrase) =>
      this.hasPhrase(context.normalized, phrase),
    );
    const synonymMatch = profile.synonymPhrases.some((phrase) =>
      this.hasPhrase(context.normalized, phrase),
    );
    const sideMatch = !profile.side || context.sideHints.has(profile.side);

    if (profile.side) {
      if (mode === 'metric' || mode === 'query') {
        if (!(hasStemTokens && sideMatch)) {
          return 0;
        }
      } else if (!(hasStemTokens && (sideMatch || hasSubcategory || hasDescriptionSupport))) {
        return 0;
      }
    }

    if (!profile.side && !synonymMatch && !exactPhraseMatch) {
      if (profile.genericSingleToken) {
        if (!(hasSubcategory && (hasStemTokens || hasDescriptionSupport))) {
          return 0;
        }
      } else if (
        !(
          (hasStemTokens && (hasSubcategory || profile.stemTokens.length > 1)) ||
          (hasDescriptionSupport &&
            (hasSubcategory || hasStemTokens || descriptionMatchCount >= 3))
        )
      ) {
        return 0;
      }
    }

    if (
      mode === 'query' &&
      !synonymMatch &&
      !exactPhraseMatch &&
      !hasDescriptionSupport
    ) {
      if (profile.genericSingleToken || !hasSubcategory) {
        return 0;
      }
    }

    let score = 0;

    if (synonymMatch) {
      score += 9;
    }

    if (exactPhraseMatch) {
      score += 8;
    }

    if (hasSubcategory) {
      score += 3;
    }

    if (hasStemTokens) {
      score += profile.stemTokens.length > 1 ? 5 : 3;
    }

    if (hasDescriptionSupport) {
      score += Math.min(descriptionMatchCount * 2, 8);
    }

    if (profile.side && sideMatch) {
      score += 2;
    }

    if (
      mode === 'manual' &&
      profile.side &&
      !sideMatch &&
      hasStemTokens &&
      (exactPhraseMatch || synonymMatch)
    ) {
      score += 1;
    }

    return score;
  }

  private buildSearchContext(text: string): SearchContext {
    const normalized = this.normalizeText(text);
    const tokens = new Set(this.tokenize(normalized));
    const sideHints = new Set<TagSide>();

    if (/(?:^|\s)(port)(?:\s|$)/i.test(normalized)) {
      sideHints.add('port');
    }
    if (/(?:^|\s)(starboard)(?:\s|$)/i.test(normalized)) {
      sideHints.add('starboard');
    }

    return {
      normalized,
      tokens,
      sideHints,
    };
  }

  private normalizeText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/\bport[\s-]*side\b/g, ' port ')
      .replace(/\b(?:ps)\b/g, ' port ')
      .replace(/\bstarboard[\s-]*side\b/g, ' starboard ')
      .replace(/\b(?:stbd|stb|sb)\b/g, ' starboard ')
      .replace(/\bgensets?\b/g, ' generator ')
      .replace(/\b15\s*ppm\b/g, ' ocmd ')
      .replace(/[_.:/\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(normalized: string): string[] {
    const tokens = normalized.split(' ').filter(Boolean);
    const expanded = new Set<string>();

    for (const token of tokens) {
      expanded.add(token);
      if (token.length > 4 && token.endsWith('s')) {
        expanded.add(token.slice(0, -1));
      }
    }

    return [...expanded];
  }

  private hasPhrase(haystack: string, needle: string): boolean {
    if (!needle) {
      return false;
    }

    const pattern = needle
      .split(' ')
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');

    if (!pattern) {
      return false;
    }

    return new RegExp(`(?:^|\\s)${pattern}(?=\\s|$)`, 'i').test(haystack);
  }
}
