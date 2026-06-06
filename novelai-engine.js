/**
 * ═══════════════════════════════════════════════════════════════════
 *  HOMEROOM — NOVELAI ENGINE  v2.0
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
 *  v2.0 rewrite notes:
 *    - Switched from /ai/generate to /ai/generate-stream.
 *      The non-streaming endpoint requires input pre-tokenized as base64
 *      packed uint32 Llama 3 token IDs — impractical without shipping the
 *      full 160 KB vocab. The streaming endpoint accepts a plain UTF-8
 *      string for `input`, which is what the NAI web app itself sends.
 *    - Response comes back as Server-Sent Events (SSE). Each `data:` line
 *      is JSON with a `token` field containing decoded plain text.
 *      We accumulate tokens until the stream closes.
 *    - Removed all tokenizer / base64 encode-decode logic.
 *    - Added timeout (15 s) so a hanging stream doesn't stall the room.
 *    - model: 'llama-3-erato-v1'  (unchanged, still correct for Erato)
 * ═══════════════════════════════════════════════════════════════════
 */

const NovelAIEngine = (() => {

  // Use the streaming endpoint — accepts plain-text `input`
  const NAI_ENDPOINT  = 'https://api.novelai.net/ai/generate-stream';
  const MODEL         = 'llama-3-erato-v1';
  const LS_KEY        = 'hr2_nai_key';
  const LS_PROXY_KEY  = 'hr2_nai_proxy';
  const TIMEOUT_MS    = 15000;

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

  // ── SSE stream reader ────────────────────────────────────────────
  // Reads a /ai/generate-stream response, accumulates token strings,
  // returns the full concatenated output text.
  async function _readStream(response) {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let   buffer  = '';
    let   output  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE lines are separated by '\n'. We process complete lines only.
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) chunk in the buffer
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const evt = JSON.parse(payload);
          // NAI stream events: { token: "...", ... }
          if (typeof evt.token === 'string') {
            output += evt.token;
          }
        } catch {
          // Malformed JSON line — skip
        }
      }
    }

    return output;
  }

  // ── API call ─────────────────────────────────────────────────────
  async function _callNAI(promptText) {
    const key = getKey();
    if (!key) throw new Error('No NAI key set.');

    const body = {
      input: promptText,      // ← plain UTF-8 string; streaming endpoint accepts this
      model: MODEL,
      parameters: {
        max_length:               80,
        min_length:               10,
        temperature:              0.85,
        top_p:                    0.95,
        top_k:                    0,
        min_p:                    0.05,
        repetition_penalty:       1.1,
        repetition_penalty_range: 512,
        generate_until_sentence:  true,
        use_cache:                false,
        return_full_text:         false,
      },
    };

    const endpoint = getProxy() || NAI_ENDPOINT;

    // Wrap in a timeout so a stalled stream doesn't hang forever
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
      res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`NAI ${res.status}: ${err}`);
    }

    return await _readStream(res);
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
  // Returns { ok: bool, status: number|null, message: string }
  async function testConnection() {
    const key = getKey();
    if (!key) return { ok: false, status: null, message: 'No key entered.' };

    const endpoint = getProxy() || NAI_ENDPOINT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
      res = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          input: 'Hello',
          model: MODEL,
          parameters: {
            max_length:   5,
            min_length:   1,
            temperature:  1,
            top_p:        0.95,
            top_k:        0,
            use_cache:    false,
            return_full_text: false,
          },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError' ? 'Request timed out.' : `Network error: ${e.message}`;
      console.warn('[NovelAIEngine] testConnection error:', msg);
      return { ok: false, status: null, message: msg };
    }
    clearTimeout(timer);

    if (res.ok) {
      // Drain the stream so the connection closes cleanly
      await _readStream(res).catch(() => {});
      return { ok: true, status: res.status, message: 'Connected.' };
    }

    // Try to read the error body for a useful message
    const body = await res.text().catch(() => '');
    let hint = '';
    if (res.status === 401) hint = 'Invalid or expired key.';
    else if (res.status === 402) hint = 'Subscription required / out of Anlas.';
    else if (res.status === 400) hint = `Bad request — API rejected the payload. ${body}`;
    else if (res.status === 429) hint = 'Rate limited — wait a moment and try again.';
    else hint = body || 'Unknown error.';

    console.warn(`[NovelAIEngine] testConnection failed: HTTP ${res.status}`, hint);
    return { ok: false, status: res.status, message: hint };
  }

  // ── Public API ───────────────────────────────────────────────────
  return { setKey, getKey, hasKey, setProxy, getProxy, testConnection, getReply };

})();
