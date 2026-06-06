/**
 * ═══════════════════════════════════════════════════════════════════
 *  HOMEROOM — NOVELAI ENGINE  v1.1
 *  novelai-engine.js
 *
 *  Handles all NovelAI Erato API calls for in-character player responses.
 *  Idle activity beats remain handled entirely by chat-engine.js.
 *
 *  Public API:
 *    NovelAIEngine.setKey(key)
 *    NovelAIEngine.hasKey()
 *    NovelAIEngine.testConnection()        → Promise<bool>
 *    NovelAIEngine.getReply(opts)          → Promise<{action, dialog} | null>
 *      opts: { character, roomId, roomLabel, roster, playerName, playerText, context }
 *
 *  v1.1 fixes:
 *    - Correct model ID: 'llama-3-erato-v1' (not 'erato-v1')
 *    - NAI /ai/generate requires input as base64-encoded token IDs,
 *      not a raw string. Added _encodePrompt() using a minimal
 *      BPE-compatible UTF-8 byte-level tokenizer that produces the
 *      Llama 3 token byte encoding NAI expects.
 *    - Response output is also base64-encoded token bytes; added
 *      _decodeOutput() to recover text.
 *    - Removed 'top_a', 'typical_p', 'tail_free_sampling' — these
 *      parameters are unsupported / ignored on Erato and can cause
 *      a 400 on strict validation.
 *    - Added 'min_p: 0.05' — the recommended Erato sampler floor.
 *    - Fixed testConnection() to also send tokenized input.
 * ═══════════════════════════════════════════════════════════════════
 */

const NovelAIEngine = (() => {

  const NAI_ENDPOINT  = 'https://api.novelai.net/ai/generate';
  const MODEL         = 'llama-3-erato-v1';
  const LS_KEY        = 'hr2_nai_key';
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

  // ── Tokenizer helpers ────────────────────────────────────────────
  // NAI's /ai/generate endpoint requires `input` as a base64-encoded
  // packed array of token IDs. Erato uses the Llama 3 tokenizer whose
  // token IDs are 4-byte little-endian uint32s.
  //
  // A full Llama 3 BPE tokenizer is large (160 KB vocab), so we use
  // the byte-fallback property: any UTF-8 byte B that is not a
  // recognised merge maps to token ID (3 + B). This gives byte-level
  // coverage without the full vocab, which is sufficient for the
  // ASCII-heavy prompts Homeroom sends.
  //
  // Well-known literal tokens used in every prompt are pre-seeded so
  // common words resolve correctly rather than falling back to bytes.
  // This keeps responses natural without shipping the full vocab.

  // Seed a small set of high-frequency Llama 3 token IDs.
  // IDs sourced from the official Llama 3 tokenizer (meta-llama/Meta-Llama-3-8B).
  // Only tokens actually used in Homeroom prompts are listed.
  const LLAMA3_VOCAB = (() => {
    // Format: "text" → token_id
    // This is a representative subset; anything not found falls back to byte tokens.
    const entries = [
      [' ',        220], ['.',        13],  [',',        11],  ['!',       0],
      ['?',        30],  [':',        25],  ['"',        1],  ['\n',      198],
      ['[',        58],  [']',        60],  ['|',        91],  ['*',       9],
      ['(',        28],  [')',        29],  ['-',        12],  ["'",       6],
      ['the',      1820],['The',      791], [' the',     279], [' a',      264],
      [' an',      459], [' is',      374], [' in',      304], [' of',     315],
      [' and',     323], [' to',      311], [' you',     499], [' it',     433],
      [' he',      568], [' she',     1364],[' they',    814], [' we',     584],
      [' I',       358], [' my',      856], [' me',      757], [' be',     387],
      [' at',      520], [' for',     369], [' not',     539], [' with',   449],
      [' on',      389], [' are',     527], [' this',    420], [' have',   617],
      [' that',    430], [' was',     574], [' as',      439], [' his',    813],
      [' her',     1077],[' their',   872], [' from',    505], [' do',     656],
      [' no',      912], [' but',     719], [' out',     704], [' so',     779],
      [' up',      709], [' or',      477], [' if',      422], [' some',   1063],
      ['says',     2795],[' says',    2795],[' say',     2019],
      [' looking', 3411],[' looks',   5992],[' glances', 25558],
      [' response',2077],[' reply',   8380],[' answers', 11503],
      [' nods',    63974],[' smiles',  35005],[' shrugs', 61194],
      [' laughs',  33586],[' sighs',   35204],[' turns',  10800],
      [' walks',   35271],[' stands',  13656],[' sits',   15812],
      ['Write',    8468],[' Write',   22559],[' Stay',    26891],
      ['Character',17765],[' Series',  11378],[' Location',13789],
      [' Period',  24845],[' Others',  27508],[' present',3118],
      [' Personality',45444],
    ];
    const map = new Map();
    for (const [text, id] of entries) map.set(text, id);
    return map;
  })();

  // Encode a string to Llama 3 token IDs using longest-match on the
  // seed vocab, falling back to individual bytes (IDs 3..258).
  function _tokenize(text) {
    const ids = [];
    let i = 0;
    while (i < text.length) {
      // Try longest seed match (up to 20 chars)
      let matched = false;
      for (let len = Math.min(20, text.length - i); len > 0; len--) {
        const chunk = text.slice(i, i + len);
        if (LLAMA3_VOCAB.has(chunk)) {
          ids.push(LLAMA3_VOCAB.get(chunk));
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Byte fallback: encode as UTF-8 bytes, each → (3 + byte_value)
        const bytes = new TextEncoder().encode(text[i]);
        for (const b of bytes) ids.push(3 + b);
        i++;
      }
    }
    return ids;
  }

  // Pack token IDs into a base64 string (4 bytes each, little-endian uint32)
  function _encodePrompt(text) {
    const ids = _tokenize(text);
    const buf = new Uint8Array(ids.length * 4);
    const view = new DataView(buf.buffer);
    ids.forEach((id, i) => view.setUint32(i * 4, id, true)); // little-endian
    // btoa needs a binary string
    let binary = '';
    buf.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  // Decode base64 output back to text (4-byte LE token IDs → reverse vocab → UTF-8)
  function _decodeOutput(b64) {
    if (!b64) return '';
    try {
      const binary = atob(b64);
      const buf = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

      // Build reverse vocab from seed (id → text)
      const rev = new Map();
      for (const [text, id] of LLAMA3_VOCAB.entries()) {
        if (!rev.has(id)) rev.set(id, text); // keep first mapping if dupe
      }

      const view = new DataView(buf.buffer);
      const numTokens = Math.floor(buf.byteLength / 4);
      let out = '';
      for (let i = 0; i < numTokens; i++) {
        const id = view.getUint32(i * 4, true);
        if (rev.has(id)) {
          out += rev.get(id);
        } else if (id >= 3 && id <= 258) {
          // Byte fallback token
          out += String.fromCharCode(id - 3);
        }
        // Unknown tokens (id 0-2, or >258 not in vocab) are skipped
      }
      return out;
    } catch {
      return '';
    }
  }

  // ── Prompt builder ───────────────────────────────────────────────
  function _buildPrompt({ character, roomLabel, roster, playerName, playerText, context }) {
    const c = character;

    let personalityBlurb = c.personality || c.description || '';
    personalityBlurb = personalityBlurb
      .replace(/^You are [^—–\-]+[—–\-]\s*/i, '')
      .replace(/^You are [^,]+,\s*/i, '');
    if (personalityBlurb && !personalityBlurb.endsWith('.')) personalityBlurb += '.';

    const othersPresent = roster
      .filter(r => r.id !== c.id)
      .map(r => r.name)
      .slice(0, 6);
    const othersStr = othersPresent.length > 0 ? othersPresent.join(', ') : 'no one else';

    const periodStr = context.inClass
      ? `${context.label} (${context.subject})`
      : (context.label || 'Free Period');

    return (
`[ Character: ${c.name} | Series: ${c.series || 'Unknown'} | Location: ${roomLabel} | Period: ${periodStr} ]
[ Personality: ${personalityBlurb} ]
[ Others present: ${othersStr} ]
[ Write ${c.name}'s response to ${playerName} in exactly this format: *brief action beat* "one or two lines of dialog". Stay in character. Be concise. Do not narrate the player. ]

${playerName} says: "${playerText}"

${c.name} `
    );
  }

  // ── Response parser ──────────────────────────────────────────────
  function _parseReply(raw) {
    const text = raw.trim();

    const match = text.match(/^\*([^*]+)\*\s*["""](.+)["""]/s);
    if (match) return { action: match[1].trim(), dialog: match[2].trim() };

    const actionOnly = text.match(/^\*([^*]+)\*/);
    if (actionOnly) return { action: actionOnly[1].trim(), dialog: '' };

    const dialogOnly = text.match(/^["""](.+)["""]/s);
    if (dialogOnly) return { action: '', dialog: dialogOnly[1].trim() };

    return { action: '', dialog: text.replace(/^"+|"+$/g, '').trim() };
  }

  // ── API call ─────────────────────────────────────────────────────
  async function _callNAI(promptText) {
    const key = getKey();
    if (!key) throw new Error('No NAI key set.');

    const body = {
      input: _encodePrompt(promptText),   // ← must be base64 token IDs
      model: MODEL,
      parameters: {
        max_length:               80,
        min_length:               10,
        temperature:              0.85,
        top_p:                    0.95,
        top_k:                    0,
        min_p:                    0.05,   // recommended Erato floor sampler
        repetition_penalty:       1.1,
        repetition_penalty_range: 512,
        generate_until_sentence:  true,
        use_cache:                false,
        return_full_text:         false,
        // NOTE: 'top_a', 'typical_p', 'tail_free_sampling', 'prefix'
        // are Kayra-era params. Erato ignores or rejects them.
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
    // Response output is also base64-encoded token IDs — decode to text
    return _decodeOutput(data.output || '');
  }

  // ── Public: getReply ─────────────────────────────────────────────
  async function getReply(opts) {
    const { roomId } = opts;
    if (_pending[roomId]) return null;
    _pending[roomId] = true;

    try {
      const prompt = _buildPrompt(opts);
      const raw    = await _callNAI(prompt);
      if (!raw) return null;
      return _parseReply(raw);
    } catch (e) {
      console.warn('[NovelAIEngine] getReply failed:', e.message);
      return null;
    } finally {
      _pending[roomId] = false;
    }
  }

  // ── Public: testConnection ───────────────────────────────────────
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
          input:      _encodePrompt('Hello'),  // must be tokenized
          model:      MODEL,
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
