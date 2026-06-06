/**
 * ═══════════════════════════════════════════════════════════════════
 *  HOMEROOM — NOVELAI ENGINE  v1.0
 *  novelai-engine.js
 *
 *  Handles all NovelAI Kayra API calls for in-character player responses.
 *  Idle activity beats remain handled entirely by chat-engine.js.
 *
 *  Public API:
 *    NovelAIEngine.setKey(key)
 *    NovelAIEngine.hasKey()
 *    NovelAIEngine.testConnection()        → Promise<bool>
 *    NovelAIEngine.getReply(opts)          → Promise<{action, dialog} | null>
 *      opts: { character, roomId, roomLabel, roster, playerName, playerText, context }
 * ═══════════════════════════════════════════════════════════════════
 */

const NovelAIEngine = (() => {

  const NAI_ENDPOINT = 'https://api.novelai.net/ai/generate';
  const MODEL        = 'erato-v1';  // Opus tier model
  const LS_KEY       = 'hr2_nai_key';
  const LS_PROXY_KEY  = 'hr2_nai_proxy';

  // Per-room lock — prevents stacking replies if player types fast
  const _pending = {};

  // ── Key management ──────────────────────────────────────────────
  function setKey(key) {
    if (key && key.trim()) {
      localStorage.setItem(LS_KEY, key.trim());
    } else {
      localStorage.removeItem(LS_KEY);
    }
  }

  function getKey() {
    return localStorage.getItem(LS_KEY) || '';
  }

  function hasKey() {
    return !!getKey();
  }

  // ── Proxy management ────────────────────────────────────────────
  // Allows routing through a local CORS proxy when running from file://
  function setProxy(url) {
    if (url && url.trim()) {
      localStorage.setItem(LS_PROXY_KEY, url.trim());
    } else {
      localStorage.removeItem(LS_PROXY_KEY);
    }
  }

  function getProxy() {
    return localStorage.getItem(LS_PROXY_KEY) || '';
  }

  // ── Prompt builder ───────────────────────────────────────────────
  function _buildPrompt({ character, roomLabel, roster, playerName, playerText, context }) {
    const c = character;

    // Third-person personality blurb (mirrors what buildProfileBlurb does)
    // Pull from personality field, strip "You are X —" prefix
    let personalityBlurb = c.personality || c.description || '';
    personalityBlurb = personalityBlurb
      .replace(/^You are [^—–\-]+[—–\-]\s*/i, '')
      .replace(/^You are [^,]+,\s*/i, '');
    if (personalityBlurb && !personalityBlurb.endsWith('.')) personalityBlurb += '.';

    // Roster — list other characters present (exclude the responder)
    const othersPresent = roster
      .filter(r => r.id !== c.id)
      .map(r => r.name)
      .slice(0, 6); // cap for token budget
    const othersStr = othersPresent.length > 0
      ? othersPresent.join(', ')
      : 'no one else';

    // Context line
    const periodStr = context.inClass
      ? `${context.label} (${context.subject})`
      : (context.label || 'Free Period');

    const prompt =
`[ Character: ${c.name} | Series: ${c.series || 'Unknown'} | Location: ${roomLabel} | Period: ${periodStr} ]
[ Personality: ${personalityBlurb} ]
[ Others present: ${othersStr} ]
[ Write ${c.name}'s response to ${playerName} in exactly this format: *brief action beat* "one or two lines of dialog". Stay in character. Be concise. Do not narrate the player. ]

${playerName} says: "${playerText}"

${c.name} `;

    return prompt;
  }

  // ── Response parser ──────────────────────────────────────────────
  // Expects model output like: *glances over* "Yeah, what's up?"
  // Returns { action: string, dialog: string } or { raw: string } fallback
  function _parseReply(raw) {
    const text = raw.trim();

    // Try to match *action* "dialog"
    const match = text.match(/^\*([^*]+)\*\s*["""](.+)["""]/s);
    if (match) {
      return {
        action: match[1].trim(),
        dialog: match[2].trim(),
      };
    }

    // Try just *action* with no dialog
    const actionOnly = text.match(/^\*([^*]+)\*/);
    if (actionOnly) {
      return { action: actionOnly[1].trim(), dialog: '' };
    }

    // Try just "dialog" with no action
    const dialogOnly = text.match(/^["""](.+)["""]/s);
    if (dialogOnly) {
      return { action: '', dialog: dialogOnly[1].trim() };
    }

    // Fallback — return raw so caller can still display something
    return { action: '', dialog: text.replace(/^"+|"+$/g, '').trim() };
  }

  // ── API call ─────────────────────────────────────────────────────
  async function _callNAI(prompt) {
    const key = getKey();
    if (!key) throw new Error('No NAI key set.');

    const body = {
      input: prompt,
      model: MODEL,
      parameters: {
        max_length:          80,
        min_length:          10,
        temperature:         0.85,
        top_p:               0.95,
        top_k:               0,
        top_a:               1,
        typical_p:           1,
        tail_free_sampling:  1,
        repetition_penalty:  1.1,
        repetition_penalty_range: 512,
        generate_until_sentence: true,
        use_cache:           false,
        return_full_text:    false,
        prefix:              'vanilla',
      },
    };

    const endpoint = getProxy() || NAI_ENDPOINT;
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`NAI ${res.status}: ${err}`);
    }

    const data = await res.json();
    // NAI returns { output: "..." }
    return data.output || '';
  }

  // ── Public: getReply ─────────────────────────────────────────────
  async function getReply(opts) {
    const { roomId } = opts;

    // Lock — don't stack
    if (_pending[roomId]) return null;
    _pending[roomId] = true;

    try {
      const prompt = _buildPrompt(opts);
      const raw    = await _callNAI(prompt);
      return _parseReply(raw);
    } catch (e) {
      console.warn('[NovelAIEngine] getReply failed:', e.message);
      return null;
    } finally {
      _pending[roomId] = false;
    }
  }

  // ── Public: testConnection ───────────────────────────────────────
  // Sends a minimal prompt to verify the key works
  async function testConnection() {
    const key = getKey();
    if (!key) return false;
    try {
      const endpoint = getProxy() || NAI_ENDPOINT;
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          input: 'Hello',
          model: MODEL,
          parameters: { max_length: 5 },
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Public API ───────────────────────────────────────────────────
  return { setKey, getKey, hasKey, setProxy, getProxy, testConnection, getReply };

})();
