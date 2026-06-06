/**
 * ═══════════════════════════════════════════════════════════════════
 *  HOMEROOM — CHAT ENGINE  v1.0
 *  chat-engine.js
 *
 *  External module. No API calls. No dependencies.
 *  Include via: <script src="chat-engine.js"></script>
 *  Then call:   ChatEngine.init(characters, homerooms, player, getContextFn)
 *
 *  Public API:
 *    ChatEngine.init(chars, homerooms, player, getContextFn)
 *    ChatEngine.openRoom(roomId)
 *    ChatEngine.closeRoom()
 *    ChatEngine.sendMessage(roomId, text)   — player sends a message
 *    ChatEngine.tick(roomId)                — manually fire an activity beat
 *    ChatEngine.getLogs(roomId)             — returns message array
 *    ChatEngine.clearLog(roomId)
 * ═══════════════════════════════════════════════════════════════════
 */

const ChatEngine = (() => {

  // ── Internal state ──────────────────────────────────────────────
  let _chars     = {};   // character map { id: charObj }
  let _homerooms = {};   // homeroom map  { roomId: [charId, ...] }
  let _player    = {};   // player object
  let _getCtx    = null; // fn() → { inClass, subject, period, label }
  let _activeRoom = null;
  let _tickHandle = null;
  let _onUpdate   = null; // callback(roomId, log) fired after any change

  const LS_PREFIX = 'hr2_chat_';

  // ── Tick config ─────────────────────────────────────────────────
  const TICK_INTERVAL_MS   = 18000;  // activity fires every ~18s on average
  const TICK_JITTER_MS     = 10000;  // ± jitter so it feels organic
  const MAX_LOG_PER_ROOM   = 200;    // cap stored messages

  // ════════════════════════════════════════════════════════════════
  //  MOOD ↔ TAG AFFINITY TABLE
  //  Maps mood names → tags that raise affinity for that mood
  // ════════════════════════════════════════════════════════════════
  const MOOD_TAGS = {
    restless:    ['impulsive','restless','chaotic','hyperactive','reckless','energetic','loud'],
    focused:     ['studious','intellectual','disciplined','calm','stoic','wise','measured','strategic'],
    playful:     ['playful','joyful','funny','enthusiastic','warm','friendly','party','charismatic'],
    mischievous: ['trickster','mischievous','sarcastic','chaotic','scheming','con-artist','rebellious'],
    brooding:    ['brooding','dark','serious','stoic','reserved','edgy','cynical','antisocial'],
    energetic:   ['energetic','hyperactive','loud','impulsive','chaotic','brave','fast'],
    calm:        ['calm','gentle','quiet','stoic','measured','composed','polite','caring'],
    nervous:     ['nervous','anxious','timid','cautious','cautious','earnest'],
    social:      ['friendly','social','warm','gossipy','charming','confident','flamboyant'],
    dramatic:    ['theatrical','dramatic','boastful','proud','villain','antagonist','arrogant'],
    competitive: ['competitive','proud','arrogant','ambitious','warrior','fighter','juggernaut'],
    protective:  ['protective','loyal','guardian','mentor','father','warm','earnest'],
  };

  // ════════════════════════════════════════════════════════════════
  //  REACTOR ARCHETYPE TABLE
  //  Tags → archetype name → reaction line pool
  // ════════════════════════════════════════════════════════════════
  const REACTOR_ARCHETYPES = {
    unbothered: {
      tags: ['stoic','calm','composed','measured','wise','strategic'],
      lines: [
        'glances over briefly, then returns to their work without a word.',
        'doesn\'t react. Not visibly, anyway.',
        'offers a single, unreadable look before looking away.',
        'continues what they were doing as if nothing happened.',
        'pauses for exactly one second, then carries on.',
      ],
    },
    rattled: {
      tags: ['nervous','anxious','timid','earnest','cautious'],
      lines: [
        'shifts uncomfortably in their seat.',
        'looks up with a slightly startled expression.',
        'glances around to see if anyone else noticed.',
        'fidgets quietly, clearly unsettled.',
        'pulls their things a little closer to themselves.',
      ],
    },
    enabling: {
      tags: ['chaotic','impulsive','hyperactive','playful','trickster','mischievous'],
      lines: [
        'immediately perks up and looks over with obvious interest.',
        'grins and leans in like this is the best thing that\'s happened all day.',
        'looks like they\'re about to make this much worse.',
        'gives an encouraging nod, absolutely not helping.',
        'silently signals their approval with a thumbs up.',
      ],
    },
    disapproving: {
      tags: ['studious','intellectual','disciplined','honorable','serious','stoic'],
      lines: [
        'exhales slowly and shifts slightly further away.',
        'looks up, says nothing, but the disappointment is visible.',
        'marks their place and gives a pointed look.',
        'purses their lips and returns to their notes without comment.',
        'makes a quiet, unimpressed sound.',
      ],
    },
    dry: {
      tags: ['sarcastic','blunt','cynical','antisocial','unhinged','sharp'],
      lines: [
        'doesn\'t look up. "Sure."',
        'stares for a moment. "Okay."',
        'turns a page. "Fascinating."',
        'glances over. "This class gets worse every day."',
        'says nothing, but their expression says everything.',
      ],
    },
    warm: {
      tags: ['friendly','warm','caring','empathetic','protective','loyal','social'],
      lines: [
        'looks over with a small, genuine smile.',
        'gives a quiet, encouraging nod.',
        'catches their eye and offers a sympathetic look.',
        'seems quietly pleased by the whole thing.',
        'watches for a moment with obvious fondness.',
      ],
    },
    competitive: {
      tags: ['competitive','proud','arrogant','ambitious','arrogant','juggernaut'],
      lines: [
        'glances over and immediately starts doing something slightly more impressive.',
        'watches, unimpressed, and makes a mental note.',
        'raises an eyebrow. Considers it a challenge.',
        'files this away for later. Everything is a competition.',
        'looks like they\'re already planning a response.',
      ],
    },
    theatrical: {
      tags: ['theatrical','boastful','dramatic','villain','antagonist','flamboyant'],
      lines: [
        'turns dramatically in their seat to observe.',
        'makes a quiet sound of studied disapproval, mostly for effect.',
        'steeples their fingers and watches with great interest.',
        'adopts an expression of elaborate, performed surprise.',
        'quietly decides to use this somehow.',
      ],
    },
    amused: {
      tags: ['charming','funny','playful','joyful','charismatic','eccentric'],
      lines: [
        'covers a smile behind their hand.',
        'lets out a quiet, surprised laugh.',
        'shakes their head, clearly delighted.',
        'watches with the expression of someone witnessing a gift.',
        'bites their lip. Barely holds it together.',
      ],
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  FALLBACK ACTIVITY POOLS
  //  Used when a character has no authored activities yet
  //  Keyed by mood, each entry is a text template
  // ════════════════════════════════════════════════════════════════
  const FALLBACK_ACTIVITIES = {
    restless: [
      'tapping their pen against the desk in an irregular rhythm.',
      'spinning a pencil between their fingers, not really focusing.',
      'fidgeting with whatever is nearest to them.',
      'keeps glancing toward the door.',
      'quietly drumming on their desk with two fingers.',
      'shifts in their seat for the third time in five minutes.',
    ],
    focused: [
      'bent over their notes, writing in small, careful handwriting.',
      'rereading the same page of their textbook with total concentration.',
      'quietly organizing their notes by color-coded tabs.',
      'making a detailed diagram in the margin of their notebook.',
      'appears to be three steps ahead of everyone else in the room.',
    ],
    playful: [
      'doodling something in the corner of their notes.',
      'passing a small folded note under their desk.',
      'quietly doing something under the desk that is clearly not classwork.',
      'whispering something to the person nearest to them.',
      'grinning at nothing in particular.',
    ],
    mischievous: [
      'watching the room with the quiet attention of someone planning something.',
      'occasionally glancing at other people\'s work with obvious interest.',
      'scribbling something in their notebook that is definitely not notes.',
      'making very minimal effort to look like they\'re paying attention.',
      'has that specific expression that means something is about to happen.',
    ],
    brooding: [
      'staring out the window with the distant look of someone doing complex internal math.',
      'sitting very still, not really present.',
      'doodling dark, abstract shapes in the margins.',
      'resting their chin on one hand, watching nothing in particular.',
      'quietly existing in a cloud of unspoken thoughts.',
    ],
    energetic: [
      'bouncing their leg under the desk at a pace that suggests limitless inner reserves.',
      'sitting slightly forward in their seat, ready to go.',
      'mouthing words quietly, running something through their head.',
      'barely containing the impulse to do something with all this energy.',
      'radiating enough restless energy to make the desk feel too small.',
    ],
    calm: [
      'sitting quietly with a composed, settled quality.',
      'reading ahead in the textbook.',
      'taking slow, measured notes with even handwriting.',
      'completely still, seemingly at peace with the whole situation.',
      'watching the room with the comfortable stillness of someone who has nowhere else to be.',
    ],
    nervous: [
      'keeping their eyes on their notebook to avoid eye contact.',
      'pressing their pen a little too hard on the paper.',
      'glancing at the front of the room every few seconds.',
      'quietly triple-checking the notes they already took.',
      'sits very straight, like they\'re waiting for something to go wrong.',
    ],
    social: [
      'scanning the room with mild, friendly curiosity.',
      'catching someone\'s eye and offering a small smile.',
      'leaning slightly toward the person next to them.',
      'paying attention to the room as much as the lesson.',
      'looks like they have something to say and is waiting for the right moment.',
    ],
    dramatic: [
      'holding their pen with an air of theatrical purpose.',
      'sits with unusually perfect posture, as if being observed.',
      'occasionally glancing around to see who\'s watching.',
      'writes something in their notebook with a certain ceremony.',
      'has the bearing of someone who considers every moment a performance.',
    ],
    competitive: [
      'tracking how far ahead others are in the reading.',
      'doing the work faster than is strictly necessary.',
      'writing with the focused intensity of someone keeping score.',
      'quietly assessing the rest of the class.',
      'already on the next problem.',
    ],
    protective: [
      'keeping an eye on the people around them without making it obvious.',
      'positioned slightly outward in their seat, aware of the room.',
      'glances up whenever someone nearby makes a sound.',
      'taking notes that seem to include more context than strictly needed.',
      'steady and watchful, like background security for the classroom.',
    ],
    any: [
      'staring at a fixed point somewhere above the whiteboard.',
      'quietly doing something with their hands.',
      'shifting slightly in their seat.',
      'pausing mid-note and looking thoughtfully at nothing.',
      'sitting with that specific stillness of someone whose mind is somewhere else.',
    ],
  };

  // ════════════════════════════════════════════════════════════════
  //  PLAYER MESSAGE RESPONSE POOLS
  //  When the player sends a message, a character in the room may reply.
  //  Keyed by mood/archetype, responses are generic openers that fit
  //  the personality — the engine picks by tag affinity.
  // ════════════════════════════════════════════════════════════════
  const PLAYER_RESPONSES = {
    restless: [
      'looks up from whatever they were doing. "{player}? Yeah, what\'s up."',
      'swings around in their seat. "Oh hey. What."',
      'glances over. "What\'s going on?"',
    ],
    focused: [
      'marks their place and looks up carefully. "Did you need something?"',
      'pauses their work. "Yes?"',
      'looks up slowly, like they were very far away a moment ago.',
    ],
    playful: [
      'immediately lights up. "Hey! What? Tell me."',
      'leans over with interest. "Oh this is gonna be good, I can tell."',
      'grins. "What\'s up?"',
    ],
    mischievous: [
      'tilts their head slowly. "Interesting timing."',
      'watches you for a second before responding. "Sure. I\'m listening."',
      'raises an eyebrow. "What do you want?"',
    ],
    brooding: [
      'turns to look at you with the weight of someone emerging from deep thought.',
      'doesn\'t say anything immediately. Just waits.',
      'gives a measured look. "What."',
    ],
    energetic: [
      '"YES. Hi. What\'s happening."',
      'spins toward you immediately. "What? What? Tell me."',
      '"Oh finally, something\'s happening. What is it?"',
    ],
    calm: [
      'looks over with quiet attention. "What\'s on your mind?"',
      'offers a gentle nod. "I\'m listening."',
      '"Hey. What\'s up?"',
    ],
    nervous: [
      'looks up quickly, a little startled. "Oh — yeah, hi."',
      '"Hm? Sorry — I was — what did you say?"',
      'looks over carefully, unsure if they\'re in trouble.',
    ],
    social: [
      '"Oh hey! I was wondering when you\'d say something."',
      'turns fully toward you, all in. "What\'s going on?"',
      '"Tell me everything."',
    ],
    dramatic: [
      'turns toward you with slow, deliberate attention.',
      '"Ah." A pause. "You\'ve come to me."',
      'considers you for a moment before speaking. "Yes?"',
    ],
    competitive: [
      'glances over without turning fully. "What do you need."',
      '"Make it quick. I\'m busy."',
      'looks up with sharp attention. "What."',
    ],
    protective: [
      '"Hey — you okay?"',
      'looks over with immediate attention. "What\'s going on?"',
      '"Yeah. What do you need?"',
    ],
  };

  // ════════════════════════════════════════════════════════════════
  //  UTILITY
  // ════════════════════════════════════════════════════════════════

  function _rand(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function _chance(p) {
    return Math.random() < p;
  }

  // Weighted random pick — array of { item, weight }
  function _weightedPick(weighted) {
    const total = weighted.reduce((s, w) => s + (w.weight || 1), 0);
    let r = Math.random() * total;
    for (const w of weighted) {
      r -= (w.weight || 1);
      if (r <= 0) return w.item;
    }
    return weighted[weighted.length - 1].item;
  }

  // Replace tokens in activity text
  function _resolveTokens(text, charName, ctx) {
    return text
      .replace(/{name}/gi,    charName)
      .replace(/{subject}/gi, ctx.subject   || 'class')
      .replace(/{room}/gi,    ctx.roomLabel || 'the room')
      .replace(/{period}/gi,  ctx.label     || 'this period');
  }

  // ── Mood scoring ─────────────────────────────────────────────
  // Returns the dominant mood string for a character based on their tags
  function _scoreMood(charTags = []) {
    const lower = charTags.map(t => t.toLowerCase());
    let best = 'any', bestScore = 0;
    for (const [mood, moodTags] of Object.entries(MOOD_TAGS)) {
      const score = moodTags.filter(mt => lower.some(t => t.includes(mt))).length;
      if (score > bestScore) { bestScore = score; best = mood; }
    }
    return best;
  }

  // Returns an archetype name for a reactor character
  function _scoreArchetype(charTags = []) {
    const lower = charTags.map(t => t.toLowerCase());
    let best = 'unbothered', bestScore = 0;
    for (const [arch, def] of Object.entries(REACTOR_ARCHETYPES)) {
      const score = def.tags.filter(mt => lower.some(t => t.includes(mt))).length;
      if (score > bestScore) { bestScore = score; best = arch; }
    }
    return best;
  }

  // ════════════════════════════════════════════════════════════════
  //  LOG PERSISTENCE
  // ════════════════════════════════════════════════════════════════

  function _loadLog(roomId) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + roomId);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function _saveLog(roomId, log) {
    try {
      // Trim to cap
      const trimmed = log.slice(-MAX_LOG_PER_ROOM);
      localStorage.setItem(LS_PREFIX + roomId, JSON.stringify(trimmed));
    } catch (e) {
      console.warn('[ChatEngine] Could not save log:', e);
    }
  }

  // ── Append a message to a room log ───────────────────────────
  function _appendMessage(roomId, msg) {
    const log = _loadLog(roomId);
    log.push(msg);
    _saveLog(roomId, log);
    if (_onUpdate) _onUpdate(roomId, log);
  }

  // Message factory
  function _msg(type, speakerId, text, meta = {}) {
    return {
      id:        Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      timestamp: Date.now(),
      type,        // 'activity' | 'reaction' | 'player' | 'system'
      speakerId,   // character id or '__player__'
      speakerName: speakerId === '__player__'
        ? (_player.name || 'You')
        : (_chars[speakerId]?.name || speakerId),
      text,
      ...meta,
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  ACTIVITY PICKER
  //  Picks an activity for a given character in the current context
  // ════════════════════════════════════════════════════════════════
  function _pickActivity(charId, ctx) {
    const c = _chars[charId];
    if (!c) return null;

    const mood = _scoreMood(c.tags || []);
    const authored = (c.activities || []).filter(a => {
      // Context filter
      if (!ctx.inClass && a.context?.includes('free'))     return true;
      if (ctx.inClass  && a.context?.includes('in-class')) return true;
      if (!a.context || a.context.length === 0)            return true;
      return false;
    });

    let actText;

    if (authored.length > 0) {
      // Mood-weight authored activities: boost weight if mood matches
      const weighted = authored.map(a => ({
        item: a,
        weight: (a.weight || 1) * (a.mood === mood || a.mood === 'any' ? 2 : 1),
      }));
      const chosen = _weightedPick(weighted);
      actText = _resolveTokens(chosen.text, c.name, ctx);
      return { text: actText, trigger: chosen.trigger || null, mood };
    } else {
      // Fallback pool
      const pool = FALLBACK_ACTIVITIES[mood] || FALLBACK_ACTIVITIES.any;
      actText = _resolveTokens(_rand(pool), c.name, ctx);
      // Fallback trigger: small random chance, no filter
      const hasTrigger = _chance(0.2);
      return {
        text: actText,
        trigger: hasTrigger ? { chance: 0.2, targets: 'nearby', filter: [] } : null,
        mood,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  REACTION DERIVER
  //  Given a reactor character and an activity, returns a reaction line
  // ════════════════════════════════════════════════════════════════
  function _deriveReaction(reactorId) {
    const c = _chars[reactorId];
    if (!c) return null;
    const arch = _scoreArchetype(c.tags || []);
    const def  = REACTOR_ARCHETYPES[arch] || REACTOR_ARCHETYPES.unbothered;
    return _rand(def.lines);
  }

  // ════════════════════════════════════════════════════════════════
  //  TRIGGER RESOLVER
  //  Picks a reactor from the room matching trigger filter
  // ════════════════════════════════════════════════════════════════
  function _resolveTrigger(trigger, actorId, roomId) {
    if (!trigger) return null;
    if (!_chance(trigger.chance || 0.25)) return null;

    const roster = (_homerooms[roomId] || []).filter(id => id !== actorId);
    if (roster.length === 0) return null;

    let pool = roster;

    // Scope: same-clique
    if (trigger.targets === 'same-clique') {
      const actorClique = _getClique(actorId);
      if (actorClique) {
        pool = roster.filter(id => _getClique(id) === actorClique);
        if (pool.length === 0) pool = roster; // fallback
      }
    }

    // Tag filter
    if (trigger.filter && trigger.filter.length > 0) {
      const filterLower = trigger.filter.map(f => f.toLowerCase());
      const filtered = pool.filter(id => {
        const tags = (_chars[id]?.tags || []).map(t => t.toLowerCase());
        return filterLower.some(f => tags.some(t => t.includes(f)));
      });
      if (filtered.length > 0) pool = filtered;
    }

    return _rand(pool);
  }

  function _getClique(charId) {
    const CLIQUE_TAGS = ['honors','jocks','arts','rebels','popular','nerds','newcomers','loners'];
    const tags = (_chars[charId]?.tags || []).map(t => t.toLowerCase());
    return CLIQUE_TAGS.find(cl => tags.includes(cl)) || null;
  }

  // ════════════════════════════════════════════════════════════════
  //  ACTIVITY BEAT
  //  Pick an actor, generate activity, maybe trigger a reaction
  // ════════════════════════════════════════════════════════════════
  function _fireActivityBeat(roomId) {
    const roster = _homerooms[roomId] || [];
    if (roster.length === 0) return;

    const ctx = _getCtx ? _getCtx() : { inClass: false, subject: 'class', label: 'Free Period', roomLabel: `Room ${roomId}` };
    ctx.roomLabel = `Room ${roomId}`;

    // Pick a random actor (bias toward variety — avoid repeating last actor)
    const actorId = _rand(roster);
    const activity = _pickActivity(actorId, ctx);
    if (!activity) return;

    // Post activity message
    const actMsg = _msg('activity', actorId, activity.text);
    _appendMessage(roomId, actMsg);

    // Resolve trigger
    if (activity.trigger) {
      const reactorId = _resolveTrigger(activity.trigger, actorId, roomId);
      if (reactorId) {
        const reactionText = _deriveReaction(reactorId);
        if (reactionText) {
          // Small delay so it reads as a response, not simultaneous
          setTimeout(() => {
            const reactMsg = _msg('reaction', reactorId, reactionText, { reactingTo: actMsg.id });
            _appendMessage(roomId, reactMsg);
          }, 1200 + Math.random() * 1800);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  TICK SCHEDULER
  //  Randomized interval so the room feels organic, not clockwork
  // ════════════════════════════════════════════════════════════════
  function _scheduleNextTick(roomId) {
    if (_tickHandle) clearTimeout(_tickHandle);
    const delay = TICK_INTERVAL_MS + (Math.random() * TICK_JITTER_MS * 2 - TICK_JITTER_MS);
    _tickHandle = setTimeout(() => {
      if (_activeRoom === roomId) {
        _fireActivityBeat(roomId);
        _scheduleNextTick(roomId);
      }
    }, delay);
  }

  function _stopTicker() {
    if (_tickHandle) { clearTimeout(_tickHandle); _tickHandle = null; }
  }

  // ════════════════════════════════════════════════════════════════
  //  PLAYER MESSAGE HANDLING
  //  When the player sends something, one character in the room
  //  may respond, chosen by proximity and mood
  // ════════════════════════════════════════════════════════════════
  function _handlePlayerMessage(roomId, text) {
    const roster = (_homerooms[roomId] || []);
    if (roster.length === 0) return;

    // Post player message first
    const playerMsg = _msg('player', '__player__', text);
    _appendMessage(roomId, playerMsg);

    // ── @mention parsing ─────────────────────────────────────────
    // Player can type @Name to address someone specific
    let targetId = null;
    const mentionMatch = text.match(/@([\w\s'-]+)/i);
    if (mentionMatch) {
      const query = mentionMatch[1].trim().toLowerCase();
      targetId = roster.find(id => {
        const name = (_chars[id]?.name || '').toLowerCase();
        return name.startsWith(query) || name.includes(query);
      }) || null;
    }

    // ── Pick responder ───────────────────────────────────────────
    // @mention → that character; otherwise weighted random biased toward social
    let responderId = targetId;
    if (!responderId) {
      const scored = roster.map(id => {
        const tags  = (_chars[id]?.tags || []).map(t => t.toLowerCase());
        const social = ['friendly','social','warm','charming','enthusiastic','loud','playful']
          .filter(t => tags.includes(t)).length;
        return { id, weight: 1 + social };
      });
      responderId = _weightedPick(scored.map(s => ({ item: s.id, weight: s.weight })));
    }

    // ── Route through NovelAI if available ───────────────────────
    if (typeof NovelAIEngine !== 'undefined' && NovelAIEngine.hasKey()) {
      const ctx        = _getCtx ? _getCtx() : {};
      const character  = _chars[responderId];
      const rosterObjs = roster.map(id => _chars[id]).filter(Boolean);

      NovelAIEngine.getReply({
        character,
        roomId,
        roomLabel:  ctx.roomLabel || `Room ${roomId}`,
        roster:     rosterObjs,
        playerName: _player.name || 'You',
        playerText: text,
        context:    ctx,
      }).then(reply => {
        if (!reply) {
          // NAI failed — fall back to static pool
          _staticReply(roomId, responderId);
          return;
        }

        // Build a combined action+dialog text for the message
        let combined = '';
        if (reply.action && reply.dialog) {
          combined = `*${reply.action}* "${reply.dialog}"`;
        } else if (reply.action) {
          combined = `*${reply.action}*`;
        } else if (reply.dialog) {
          combined = `"${reply.dialog}"`;
        }

        if (!combined) {
          _staticReply(roomId, responderId);
          return;
        }

        const respMsg = _msg('nai-reply', responderId, combined, { replyToPlayer: true });
        _appendMessage(roomId, respMsg);
      });

      return; // NAI is async — exit here, reply comes in the .then()
    }

    // ── Static fallback (no NAI key) ─────────────────────────────
    _staticReply(roomId, responderId);
  }

  // Static response pool reply — used as fallback when NAI is unavailable
  function _staticReply(roomId, responderId) {
    const mood = _scoreMood(_chars[responderId]?.tags || []);
    const pool = PLAYER_RESPONSES[mood] || PLAYER_RESPONSES.calm;
    const responseText = _rand(pool).replace(/{player}/g, _player.name || 'you');

    setTimeout(() => {
      const respMsg = _msg('reaction', responderId, responseText, { replyToPlayer: true });
      _appendMessage(roomId, respMsg);
    }, 800 + Math.random() * 1400);
  }

  // ════════════════════════════════════════════════════════════════
  //  SYSTEM MESSAGE — posted when entering a room
  // ════════════════════════════════════════════════════════════════
  function _postSystemEntry(roomId) {
    const ctx  = _getCtx ? _getCtx() : {};
    const size = (_homerooms[roomId] || []).length;
    let text;
    if (ctx.inClass) {
      text = `${ctx.label} is in session. ${size} student${size !== 1 ? 's' : ''} present.`;
    } else {
      text = `${ctx.label || 'Free period'} — ${size} student${size !== 1 ? 's' : ''} hanging around Room ${roomId}.`;
    }
    const msg = _msg('system', '__system__', text);
    _appendMessage(roomId, msg);
  }

  // ════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════════════════════════════
  return {

    /**
     * init — wire up the engine
     * @param {Object} chars       — { id: charObj } from homeroom.html
     * @param {Object} homerooms   — { roomId: [charId, ...] }
     * @param {Object} player      — player state object
     * @param {Function} getCtxFn  — () => { inClass, subject, period, label }
     * @param {Function} onUpdate  — (roomId, log) => void — called on every change
     */
    init(chars, homerooms, player, getCtxFn, onUpdate) {
      _chars     = chars;
      _homerooms = homerooms;
      _player    = player;
      _getCtx    = getCtxFn;
      _onUpdate  = onUpdate || null;
      console.log(`[ChatEngine] Initialized — ${Object.keys(chars).length} characters, ${Object.keys(homerooms).length} rooms`);
    },

    /**
     * openRoom — start the activity ticker for a room
     * Posts a system entry message, fires an initial beat, starts ticker
     */
    openRoom(roomId) {
      if (_activeRoom === roomId) return; // already open
      _stopTicker();
      _activeRoom = roomId;
      _postSystemEntry(roomId);
      // Fire an initial beat after a short warm-up
      setTimeout(() => {
        if (_activeRoom === roomId) _fireActivityBeat(roomId);
      }, 3000);
      _scheduleNextTick(roomId);
      console.log(`[ChatEngine] Opened room ${roomId}`);
    },

    /**
     * closeRoom — pause the ticker
     */
    closeRoom() {
      _stopTicker();
      _activeRoom = null;
    },

    /**
     * sendMessage — player sends a chat message into a room
     */
    sendMessage(roomId, text) {
      if (!text || !text.trim()) return;
      _handlePlayerMessage(roomId, text.trim());
    },

    /**
     * tick — manually fire one activity beat (for testing / forced refresh)
     */
    tick(roomId) {
      _fireActivityBeat(roomId || _activeRoom);
    },

    /**
     * getLogs — return the stored message array for a room
     */
    getLogs(roomId) {
      return _loadLog(roomId);
    },

    /**
     * clearLog — wipe stored messages for a room
     */
    clearLog(roomId) {
      localStorage.removeItem(LS_PREFIX + roomId);
      if (_onUpdate) _onUpdate(roomId, []);
    },

    /**
     * getActiveRoom — returns currently open room id or null
     */
    getActiveRoom() {
      return _activeRoom;
    },

    /**
     * updatePlayer — call when player state changes
     */
    updatePlayer(player) {
      _player = player;
    },

    /**
     * updateChars — call when character data changes (editor export reload)
     */
    updateChars(chars) {
      _chars = chars;
    },

    // ── Expose internals for debugging ──────────────────────────
    _debug: {
      scoreMood:       (tags) => _scoreMood(tags),
      scoreArchetype:  (tags) => _scoreArchetype(tags),
      pickActivity:    (charId, ctx) => _pickActivity(charId, ctx),
      deriveReaction:  (reactorId) => _deriveReaction(reactorId),
      fireManualBeat:  (roomId) => _fireActivityBeat(roomId),
    },
  };

})();
