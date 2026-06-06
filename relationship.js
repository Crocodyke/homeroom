// ═══════════════════════════════════════════════════════════════════
//  HOMEROOM — RELATIONSHIP ENGINE  v1.0
//  relationship.js
//
//  Trait-driven affinity, mood, and reaction system.
//  Works with any character that has a `tags` array.
//  Adding characters to characters.json gives them a full
//  relationship profile automatically — no extra configuration.
//
//  Designed to stage AI context injection: getContext(charId)
//  returns everything an AI needs to know about this relationship.
//
//  Include via: <script src="relationship.js"></script>
//  Depends on:  school-clock.js (for phase-aware mood shifts)
//
//  Public API:
//    Relationships.init(characters)           — call after characters loaded
//    Relationships.load()                     — restore from localStorage
//    Relationships.save()                     — persist to localStorage
//    Relationships.getAffinity(charId)        — 0–100 score
//    Relationships.getLevel(charId)           — { n, label, icon, color, nextAt }
//    Relationships.getMood(charId)            — { id, label, icon, valence }
//    Relationships.getTrustRate(charId)       — 0.2–2.0 multiplier
//    Relationships.processMessage(charId, text, direct?) — returns delta info
//    Relationships.onPhaseChange(phaseId)     — wire to SchoolClock.onPhaseChange
//    Relationships.getContext(charId)         — full AI-ready context object
//    Relationships.getAllContext()            — all characters' contexts
//    Relationships.getToneForText(text)       — detect tone of a string (debug)
// ═══════════════════════════════════════════════════════════════════

const Relationships = (() => {
  'use strict';

  const LS_KEY  = 'hr2_relationships';
  const LOG_MAX = 20;   // max interaction log entries per character

  // ═══════════════════════════════════════════════════════════════
  //  RELATIONSHIP LEVELS
  //  Crossing a threshold triggers a UI event.
  //  nextAt = minimum affinity required to reach the NEXT level.
  // ═══════════════════════════════════════════════════════════════
  const LEVELS = [
    { n: 0, label: 'Stranger',     icon: '👤', color: '#9a9a9a', nextAt: 15  },
    { n: 1, label: 'Noticed',      icon: '👁️', color: '#7a8aaa', nextAt: 30  },
    { n: 2, label: 'Acquaintance', icon: '🤝', color: '#5a9a7a', nextAt: 45  },
    { n: 3, label: 'Friendly',     icon: '😊', color: '#7aaa3a', nextAt: 60  },
    { n: 4, label: 'Friend',       icon: '💙', color: '#4a8aaa', nextAt: 75  },
    { n: 5, label: 'Close Friend', icon: '🧡', color: '#c07830', nextAt: 90  },
    { n: 6, label: 'Bond',         icon: '⭐', color: '#c9992a', nextAt: 101 },
  ];

  // ═══════════════════════════════════════════════════════════════
  //  MOOD DEFINITIONS
  //  valence: emotional tone (-2 negative → +3 very positive)
  //  Used by AI context and affinity delta modifiers.
  // ═══════════════════════════════════════════════════════════════
  const MOODS = {
    elated:    { label: 'Elated',    icon: '✨', valence:  3 },
    happy:     { label: 'Happy',     icon: '😊', valence:  2 },
    energized: { label: 'Energized', icon: '⚡', valence:  2 },
    playful:   { label: 'Playful',   icon: '😄', valence:  2 },
    focused:   { label: 'Focused',   icon: '📖', valence:  1 },
    neutral:   { label: 'Neutral',   icon: '😐', valence:  0 },
    restless:  { label: 'Restless',  icon: '😤', valence: -1 },
    brooding:  { label: 'Brooding',  icon: '🌑', valence: -1 },
    withdrawn: { label: 'Withdrawn', icon: '🚪', valence: -1 },
    irritated: { label: 'Irritated', icon: '😠', valence: -2 },
  };

  // Ordered mood ladder for valence-based bumps (positive → negative)
  const MOOD_LADDER = ['elated','happy','energized','playful','focused','neutral','restless','brooding','withdrawn','irritated'];

  // ═══════════════════════════════════════════════════════════════
  //  BASE MOOD FROM TAGS
  //  First matching tag cluster wins. Determines a character's
  //  "resting" emotional state before phase or interaction shifts.
  // ═══════════════════════════════════════════════════════════════
  const TAG_BASE_MOOD = [
    { tags: ['joyful','cheerful','bubbly','enthusiastic'],           mood: 'happy'     },
    { tags: ['hyperactive','energetic','loud','fast','caffeinated'], mood: 'energized' },
    { tags: ['playful','funny','trickster','mischievous','party'],   mood: 'playful'   },
    { tags: ['studious','intellectual','disciplined','scholar'],      mood: 'focused'   },
    { tags: ['brooding','dark','edgy','melancholy'],                  mood: 'brooding'  },
    { tags: ['anxious','nervous','timid','cautious'],                 mood: 'restless'  },
    { tags: ['antisocial','cold','withdrawn','distant'],              mood: 'withdrawn' },
    { tags: ['calm','stoic','composed','measured','wise'],            mood: 'neutral'   },
  ];

  // ═══════════════════════════════════════════════════════════════
  //  PHASE → MOOD SHIFT TABLE
  //  Each schedule phase pushes different character archetypes
  //  toward different moods. Captures the "vibe" of the school day.
  //  Archetypes map from baseMood → PHASE_MOOD_SHIFTS key.
  // ═══════════════════════════════════════════════════════════════
  //  Archetype keys: energetic | playful | focused | brooding | withdrawn | default
  const PHASE_MOOD_SHIFTS = {
    night:       { energetic: 'withdrawn', playful: 'neutral',  focused: 'brooding', brooding: 'brooding', withdrawn: 'withdrawn', default: 'withdrawn'  },
    arrival:     { energetic: 'energized', playful: 'playful',  focused: 'focused',  brooding: 'brooding', withdrawn: 'restless',  default: 'neutral'    },
    homeroom:    { energetic: 'restless',  playful: 'restless', focused: 'focused',  brooding: 'withdrawn',withdrawn: 'withdrawn', default: 'neutral'    },
    period1:     { energetic: 'restless',  playful: 'restless', focused: 'focused',  brooding: 'brooding', withdrawn: 'withdrawn', default: 'neutral'    },
    break1:      { energetic: 'energized', playful: 'playful',  focused: 'neutral',  brooding: 'neutral',  withdrawn: 'neutral',   default: 'neutral'    },
    period2:     { energetic: 'restless',  playful: 'restless', focused: 'focused',  brooding: 'brooding', withdrawn: 'withdrawn', default: 'neutral'    },
    lunch:       { energetic: 'elated',    playful: 'playful',  focused: 'happy',    brooding: 'neutral',  withdrawn: 'neutral',   default: 'happy'      },
    period3:     { energetic: 'restless',  playful: 'restless', focused: 'focused',  brooding: 'brooding', withdrawn: 'withdrawn', default: 'neutral'    },
    break2:      { energetic: 'energized', playful: 'playful',  focused: 'neutral',  brooding: 'neutral',  withdrawn: 'neutral',   default: 'neutral'    },
    period4:     { energetic: 'restless',  playful: 'restless', focused: 'focused',  brooding: 'brooding', withdrawn: 'withdrawn', default: 'neutral'    },
    afterschool: { energetic: 'elated',    playful: 'playful',  focused: 'happy',    brooding: 'brooding', withdrawn: 'neutral',   default: 'neutral'    },
    curfew:      { energetic: 'restless',  playful: 'withdrawn',focused: 'neutral',  brooding: 'brooding', withdrawn: 'withdrawn', default: 'withdrawn'  },
    freeday:     { energetic: 'elated',    playful: 'elated',   focused: 'happy',    brooding: 'neutral',  withdrawn: 'neutral',   default: 'happy'      },
  };

  // ═══════════════════════════════════════════════════════════════
  //  MESSAGE TONE DETECTION
  //  Patterns tested in order — first match wins.
  //  Covers player message "style" that characters react to.
  // ═══════════════════════════════════════════════════════════════
  const TONE_PATTERNS = [
    {
      id: 'aggressive',
      icon: '😤',
      label: 'Aggressive',
      test: t => /\b(shut up|idiot|stupid|hate you|loser|pathetic|worthless|go away|get lost|gross)\b/i.test(t),
    },
    {
      id: 'empathetic',
      icon: '🤍',
      label: 'Empathetic',
      test: t => /\b(i understand|that('s| is) (rough|hard|tough|awful|a lot)|must be (hard|tough)|sorry (to hear|for|about)|are you okay|how are you (feeling|doing)|i('m| am) (here|listening)|that sounds)\b/i.test(t),
    },
    {
      id: 'curious',
      icon: '🔍',
      label: 'Curious',
      test: t => /\?/.test(t) && /\b(what|why|how|who|when|where|tell me|explain|curious|wonder|really\?|did you|do you|can you|have you)\b/i.test(t),
    },
    {
      id: 'humorous',
      icon: '😂',
      label: 'Humorous',
      test: t => /\b(haha|hehe|lol|lmao|lmfao|joke|funny|hilarious|bro|ngl|bet|literally|no way|stop it)\b/i.test(t) || /😂|😆|🤣|💀/.test(t),
    },
    {
      id: 'chaotic',
      icon: '💥',
      label: 'Chaotic',
      test: t => /[!?]{3,}/.test(t) || /\b(omg|bruh|dude|ugh|ahhh|yooo|what the|oh my god|no way|wait what|hold on|guys|bro)\b/i.test(t) || /[A-Z]{4,}/.test(t),
    },
    {
      id: 'optimistic',
      icon: '☀️',
      label: 'Optimistic',
      test: t => /\b(amazing|awesome|great|love it|perfect|fantastic|wonderful|so good|you('re| are) (amazing|awesome|great)|this is (great|amazing)|nice|good job|proud of|happy for|believe in|you can do it|keep it up)\b/i.test(t) || /🎉|✨|💫|🌟|🌈/.test(t),
    },
    {
      id: 'assertive',
      icon: '💪',
      label: 'Assertive',
      test: t => {
        const words = t.trim().split(/\s+/);
        // Short, declarative, non-question, no internet slang
        return words.length >= 2 && words.length <= 7
          && !/\?/.test(t)
          && !/\b(lol|haha|bruh|omg|dude|bro)\b/i.test(t)
          && /^[A-Z]/.test(t.trim());
      },
    },
    {
      id: 'formal',
      icon: '📝',
      label: 'Formal',
      test: t => {
        const words = t.trim().split(/\s+/);
        return words.length >= 12
          && !/\b(lol|haha|bruh|bro|omg|wtf|ngl|bet)\b/i.test(t)
          && !/[!?]{2,}/.test(t);
      },
    },
    {
      id: 'passive',
      icon: '😶',
      label: 'Passive',
      test: t => /^\s*(ok|okay|sure|fine|whatever|idk|dunno|maybe|k|yeah|yep|nope|no|yes|alright|ig|i guess)\s*[.!?]?\s*$/i.test(t),
    },
  ];

  // ═══════════════════════════════════════════════════════════════
  //  TONE COMPATIBILITY MATRIX
  //  How each message tone lands with characters of different tag sets.
  //  bonus  → tags that make this tone resonate (affinity ↑)
  //  penalty → tags that make this tone land poorly (affinity ↓)
  //  base_delta → default change before modifiers (can be negative)
  // ═══════════════════════════════════════════════════════════════
  const TONE_COMPAT = {
    optimistic: {
      base_delta: 2,
      bonus:   ['warm','friendly','earnest','caring','joyful','bubbly','enthusiastic','cheerful','social','naive','optimistic','kind'],
      penalty: ['antisocial','cynical','sarcastic','edgy','dark','cold','stoic','brooding','jaded','distrustful'],
    },
    chaotic: {
      base_delta: 1,
      bonus:   ['chaotic','impulsive','playful','trickster','mischievous','hyperactive','joyful','funny','rebellious','unhinged','eccentric'],
      penalty: ['studious','intellectual','disciplined','honorable','calm','stoic','measured','wise','serious','composed'],
    },
    formal: {
      base_delta: 1,
      bonus:   ['stoic','composed','measured','wise','intellectual','disciplined','polite','guardian','mentor','royal','honorable'],
      penalty: ['chaotic','impulsive','playful','rebellious','antisocial','loud','hyperactive','reckless'],
    },
    assertive: {
      base_delta: 1,
      bonus:   ['competitive','proud','warrior','ambitious','leader','confident','fighter','powerful','strategic','alpha'],
      penalty: ['nervous','anxious','timid','gentle','caring','warm','earnest','shy'],
    },
    curious: {
      base_delta: 2,
      bonus:   ['intellectual','wise','studious','strategic','mentor','teacher','scholar','nerd','curious','thoughtful'],
      penalty: ['antisocial','aloof','dismissive','brusque'],
    },
    humorous: {
      base_delta: 2,
      bonus:   ['funny','playful','charming','charismatic','trickster','sarcastic','joyful','witty','chaotic'],
      penalty: ['serious','stoic','honorable','disciplined','cold','reserved','humorless'],
    },
    empathetic: {
      base_delta: 3,
      bonus:   ['warm','caring','gentle','protective','earnest','loyal','empathetic','social','family','sensitive'],
      penalty: ['antisocial','stoic','cynical','cold','edgy','dark','reserved','dismissive'],
    },
    passive: {
      base_delta: 0,
      bonus:   [],
      penalty: ['competitive','proud','social','friendly','enthusiastic','loud','charismatic'],
    },
    aggressive: {
      base_delta: -5,
      bonus:   ['aggressive','warrior','competitive','fighter','villain','brawler','edgy','ruthless'],
      penalty: ['gentle','caring','warm','nervous','earnest','guardian','protective','empathetic'],
    },
    neutral: {
      base_delta: 1,
      bonus:   [],
      penalty: [],
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  TRUST RATE MODIFIERS
  //  These tags slow or speed up how quickly affinity changes.
  //  The trust rate multiplies all affinity deltas for this character.
  //  "Reserved" characters need many more interactions to open up.
  // ═══════════════════════════════════════════════════════════════
  const SLOW_TRUST_TAGS = [
    'reserved','stoic','antisocial','cynical','brooding','dark',
    'cold','composed','distrustful','edgy','aloof','withdrawn',
    'jaded','proud','competitive', // proud/competitive chars make you earn it
  ];
  const FAST_TRUST_TAGS = [
    'warm','friendly','social','earnest','caring','enthusiastic',
    'joyful','naive','open','cheerful','bubbly','trusting','loyal',
  ];

  // ═══════════════════════════════════════════════════════════════
  //  STARTING AFFINITY
  //  Characters begin at different affinity levels based on their
  //  disposition. Antisocial characters start cold; friendly ones
  //  start warmer — but never at max.
  // ═══════════════════════════════════════════════════════════════
  const LOW_START_TAGS  = ['villain','antagonist','antisocial','cynical','brooding','cold','dark','edgy','reserved','ruthless','distrustful'];
  const HIGH_START_TAGS = ['friendly','warm','social','earnest','cheerful','joyful','bubbly','enthusiastic','protagonist','kind'];

  // ═══════════════════════════════════════════════════════════════
  //  INTERNAL STATE
  // ═══════════════════════════════════════════════════════════════
  let _chars          = {};       // character map { id: charObj }
  let _state          = {};       // { charId: RelState }
  let _currentPhaseId = 'arrival';

  // RelState shape: {
  //   affinity: number (0-100),
  //   baseMood: string (mood id, derived from tags, stable),
  //   currentMood: string (mood id, shifts with phase + interactions),
  //   moodShift: number (-5 to +5, temporary interaction modifier),
  //   log: Array<{ ts, tone, delta, mood }>,
  // }

  // ═══════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  function _tags(charId) {
    return (_chars[charId]?.tags || []).map(t => t.toLowerCase());
  }

  function _hasAnyTag(tags, list) {
    return list.some(t => tags.includes(t));
  }

  function _countMatches(tags, list) {
    return list.filter(t => tags.includes(t)).length;
  }

  function _clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Compute starting affinity from tags
  function _startAffinity(charId) {
    const tags      = _tags(charId);
    const highCount = _countMatches(tags, HIGH_START_TAGS);
    const lowCount  = _countMatches(tags, LOW_START_TAGS);
    return _clamp(30 + highCount * 5 - lowCount * 5, 5, 50);
  }

  // Compute trust rate multiplier from tags (0.2–2.0)
  function _trustRate(charId) {
    const tags     = _tags(charId);
    const slow     = _countMatches(tags, SLOW_TRUST_TAGS);
    const fast     = _countMatches(tags, FAST_TRUST_TAGS);
    return _clamp(1.0 - slow * 0.1 + fast * 0.1, 0.2, 2.0);
  }

  // Derive base mood from character tags
  function _baseMood(charId) {
    const tags = _tags(charId);
    for (const { tags: cluster, mood } of TAG_BASE_MOOD) {
      if (_hasAnyTag(tags, cluster)) return mood;
    }
    return 'neutral';
  }

  // Map baseMood → phase shift archetype key
  function _moodArchetype(baseMood) {
    const map = {
      elated:    'energetic', happy:    'energetic', energized: 'energetic',
      playful:   'playful',
      focused:   'focused',
      brooding:  'brooding',
      withdrawn: 'withdrawn',
      restless:  'withdrawn',
      irritated: 'withdrawn',
    };
    return map[baseMood] || 'default';
  }

  // Compute current mood from baseMood + phase + moodShift
  function _resolveMood(charId) {
    const base       = _state[charId]?.baseMood || 'neutral';
    const archetype  = _moodArchetype(base);
    const phaseTable = PHASE_MOOD_SHIFTS[_currentPhaseId] || {};
    const phaseMood  = phaseTable[archetype] || phaseTable['default'] || base;

    const shift = _state[charId]?.moodShift || 0;
    if (shift === 0) return phaseMood;

    // Bump up or down the MOOD_LADDER
    const idx = MOOD_LADDER.indexOf(phaseMood);
    if (idx === -1) return phaseMood;

    // Positive shift = move toward positive (lower index = better)
    const bumpSteps = shift > 0 ? -Math.min(shift, 2) : Math.min(-shift, 2);
    const newIdx    = _clamp(idx + bumpSteps, 0, MOOD_LADDER.length - 1);
    return MOOD_LADDER[newIdx];
  }

  // Compute affinity delta for a given tone and character
  function _computeDelta(charId, tone) {
    const compat     = TONE_COMPAT[tone] || TONE_COMPAT.neutral;
    const tags       = _tags(charId);
    const rate       = _trustRate(charId);
    const bonusHits  = _countMatches(tags, compat.bonus);
    const penaltyHits= _countMatches(tags, compat.penalty);

    let delta = compat.base_delta
      + bonusHits   * 1.5
      - penaltyHits * 2.0;

    // Mood modifier: positive messages hit harder in good mood, softer in bad mood
    const moodValence = MOODS[_state[charId]?.currentMood]?.valence ?? 0;
    if (delta > 0) {
      delta *= (1 + moodValence * 0.12);
    }

    // Apply this character's trust rate multiplier
    delta = delta * rate;

    // Cap single-message impact: max +10 / -15
    return _clamp(Math.round(delta), -15, 10);
  }

  // Find level object for a given affinity score
  function _levelFor(affinity) {
    let result = LEVELS[0];
    for (let i = 0; i < LEVELS.length - 1; i++) {
      if (affinity >= LEVELS[i].nextAt) result = LEVELS[i + 1];
      else break;
    }
    return result;
  }

  // Initialize a single character's state
  function _initChar(charId) {
    if (_state[charId]) return;
    const base = _baseMood(charId);
    _state[charId] = {
      affinity:    _startAffinity(charId),
      baseMood:    base,
      currentMood: base,
      moodShift:   0,
      log:         [],
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════
  return {

    // ── Initialization ──────────────────────────────────────────

    /**
     * Call after characters are loaded into the app.
     * Initializes any missing character states and updates moods
     * for the current school phase.
     */
    init(characters) {
      _chars = characters;
      // Initialize any char that doesn't have state yet
      Object.keys(characters).forEach(cid => _initChar(cid));
      // Sync phase from SchoolClock if available
      if (typeof SchoolClock !== 'undefined') {
        _currentPhaseId = SchoolClock.getState().phaseId;
      }
      // Resolve current moods for all chars
      Object.keys(_state).forEach(cid => {
        _state[cid].currentMood = _resolveMood(cid);
      });
      console.log(`[Relationships] Ready — ${Object.keys(_state).length} characters tracked`);
    },

    /** Restore persisted state from localStorage. Call before init(). */
    load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        Object.entries(saved).forEach(([cid, data]) => {
          // Merge saved data; init() will fill any missing fields
          _state[cid] = Object.assign(_state[cid] || {}, data);
        });
      } catch (e) {
        console.error('[Relationships] Load error:', e);
      }
    },

    /** Persist all state to localStorage. */
    save() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(_state));
      } catch (e) {
        console.error('[Relationships] Save error:', e);
      }
    },

    // ── Core getters ────────────────────────────────────────────

    /** Returns the current affinity score (0–100) for a character. */
    getAffinity(charId) {
      return _state[charId]?.affinity ?? 0;
    },

    /** Returns the current level object for a character. */
    getLevel(charId) {
      return _levelFor(this.getAffinity(charId));
    },

    /**
     * Returns the current mood object for a character.
     * Mood is derived from character tags, time of day, and recent interactions.
     */
    getMood(charId) {
      const id = _state[charId]?.currentMood || 'neutral';
      return { id, ...(MOODS[id] || MOODS.neutral) };
    },

    /**
     * Returns this character's trust rate multiplier (0.2–2.0).
     * Reserved/antisocial characters have low rates (need many interactions).
     * Warm/friendly characters have high rates (open up quickly).
     */
    getTrustRate(charId) {
      return _trustRate(charId);
    },

    /**
     * Returns a human-readable trust rate label for display.
     */
    getTrustLabel(charId) {
      const rate = _trustRate(charId);
      if (rate <= 0.3) return 'Very Reserved';
      if (rate <= 0.6) return 'Guarded';
      if (rate <= 0.9) return 'Cautious';
      if (rate <= 1.2) return 'Normal';
      if (rate <= 1.5) return 'Open';
      return 'Eager';
    },

    // ── Interaction processing ───────────────────────────────────

    /**
     * Process a player message. Updates affinity and mood for charId.
     *
     * @param {string}  charId  — target character
     * @param {string}  text    — the player's raw message text
     * @param {boolean} direct  — true if player @mentioned or directly addressed
     *                           this character (false = ambient room effect, ×0.35)
     * @returns {{ tone, delta, affinityBefore, affinityAfter,
     *             levelBefore, levelAfter, levelChanged }}
     */
    processMessage(charId, text, direct = true) {
      if (!_state[charId]) _initChar(charId);

      const tone           = this.getToneForText(text);
      const rawDelta       = _computeDelta(charId, tone);
      const effectiveDelta = direct ? rawDelta : Math.round(rawDelta * 0.35);

      const before      = _state[charId].affinity;
      const levelBefore = _levelFor(before);

      // Update affinity
      _state[charId].affinity = _clamp(before + effectiveDelta, 0, 100);
      const after      = _state[charId].affinity;
      const levelAfter = _levelFor(after);

      // Update mood shift
      const moodDelta = effectiveDelta > 2 ? 1 : effectiveDelta < -2 ? -1 : 0;
      _state[charId].moodShift = _clamp((_state[charId].moodShift || 0) + moodDelta, -5, 5);
      _state[charId].currentMood = _resolveMood(charId);

      // Append to interaction log
      _state[charId].log.unshift({
        ts:    Date.now(),
        tone,
        delta: effectiveDelta,
        mood:  _state[charId].currentMood,
      });
      if (_state[charId].log.length > LOG_MAX) {
        _state[charId].log.length = LOG_MAX;
      }

      this.save();

      return {
        tone,
        delta:          effectiveDelta,
        affinityBefore: before,
        affinityAfter:  after,
        levelBefore,
        levelAfter,
        levelChanged:   levelAfter.n !== levelBefore.n,
      };
    },

    // ── Phase change ────────────────────────────────────────────

    /**
     * Call this when the school day phase changes.
     * Updates all characters' moods to reflect the new context.
     * Mood shifts from interactions decay by 50% each phase transition.
     */
    onPhaseChange(phaseId) {
      _currentPhaseId = phaseId;
      Object.keys(_state).forEach(cid => {
        // Decay temporary interaction mood shift
        _state[cid].moodShift = Math.round((_state[cid].moodShift || 0) * 0.5);
        // Re-resolve mood with new phase
        _state[cid].currentMood = _resolveMood(cid);
      });
      this.save();
    },

    // ── AI context ──────────────────────────────────────────────

    /**
     * Returns a complete context object for AI injection.
     * Everything an AI needs to know about the player's relationship
     * with this character, in a structured format.
     */
    getContext(charId) {
      if (!_state[charId]) return null;
      const level = this.getLevel(charId);
      const mood  = this.getMood(charId);
      const rate  = _trustRate(charId);
      return {
        charId,
        // Quantitative
        affinity:         _state[charId].affinity,
        trustRate:        rate,
        trustLabel:       this.getTrustLabel(charId),
        // Level
        levelN:           level.n,
        levelLabel:       level.label,
        nextLevelAt:      level.nextAt,
        // Mood
        mood:             mood.id,
        moodLabel:        mood.label,
        moodValence:      mood.valence,  // -2 to +3
        baseMood:         _state[charId].baseMood,
        // Behavioral guidance for AI prompt construction
        // Higher level = more open / familiar tone from character
        // Higher moodValence = warmer responses
        // trustRate < 0.5 = character is very slow to open up
        behaviorHints: {
          isStranger:   level.n <= 1,
          isAcquainted: level.n === 2,
          isFriendly:   level.n >= 3,
          isClose:      level.n >= 5,
          isGoodMood:   mood.valence >= 1,
          isBadMood:    mood.valence <= -1,
          isReserved:   rate < 0.6,
          isOpen:       rate > 1.2,
        },
        // Recent interaction history (last 5 entries)
        recentLog: (_state[charId].log || []).slice(0, 5).map(e => ({
          tone:  e.tone,
          delta: e.delta,
          minsAgo: Math.round((Date.now() - e.ts) / 60000),
        })),
      };
    },

    /** Returns contexts for all tracked characters. */
    getAllContext() {
      const out = {};
      Object.keys(_state).forEach(cid => { out[cid] = this.getContext(cid); });
      return out;
    },

    // ── Tone utility ────────────────────────────────────────────

    /**
     * Detect the tone of a player message string.
     * Returns one of the tone ids from TONE_PATTERNS.
     */
    getToneForText(text) {
      if (!text || !text.trim()) return 'neutral';
      for (const { id, test } of TONE_PATTERNS) {
        if (test(text)) return id;
      }
      return 'neutral';
    },

    /** Returns the icon for a given tone id. */
    getToneIcon(tone) {
      return TONE_PATTERNS.find(p => p.id === tone)?.icon || '💬';
    },

    // ── Static tables (for UI rendering) ────────────────────────
    getLevels()      { return LEVELS; },
    getMoods()       { return MOODS; },
    getTonePatterns(){ return TONE_PATTERNS; },

    // ── Debug ────────────────────────────────────────────────────
    _debug: {
      state:            () => _state,
      computeDelta:     (id, tone) => _computeDelta(id, tone),
      trustRate:        (id) => _trustRate(id),
      startAffinity:    (id) => _startAffinity(id),
      baseMood:         (id) => _baseMood(id),
      resolveMood:      (id) => _resolveMood(id),
      levelFor:         (n)  => _levelFor(n),
    },
  };

})();
