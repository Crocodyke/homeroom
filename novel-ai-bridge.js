// novel-ai-bridge.js
const NovelAIEngine = (() => {
  let _apiKey = null;

  const API_URL = "https://api.novelai.net/ai/generate"; // or the chat completions endpoint

  function hasKey() {
    return !!_apiKey;
  }

  function setKey(key) {
    _apiKey = key;
    console.log("[NovelAIEngine] API key configured");
  }

  async function getReply(params) {
    const { character, playerText, context, roomLabel, roster } = params;
    if (!_apiKey) return null;

    // Build a rich, in-character prompt
    const systemPrompt = `
You are ${character.name}, a student in ${roomLabel || 'class'}.
Personality: ${character.personality || 'No specific personality provided'}.
Tags: ${character.tags ? character.tags.join(', ') : 'none'}.
Current context: ${context.subject || 'general class'}, ${context.label || 'free period'}.
Other students present: ${roster.map(c => c.name).join(', ')}.

Respond naturally in character. Use *actions* for physical/emotional beats. Keep replies 1-3 sentences. Stay immersive.
`;

    const fullPrompt = `${systemPrompt}\n\nPlayer: ${playerText}\n${character.name}:`;

    try {
      const payload = {
        model: "kayra-v1", // or "clio", "erato", etc. — test what you have access to
        input: fullPrompt,
        parameters: {
          temperature: 0.88,
          max_length: 180,
          min_length: 20,
          bad_words: ["[REDACTED]"], // add any filters
          // tail_free_sampling, etc. for better quality
        }
      };

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${_apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const output = data.output || data.response || "";

      // Parse action/dialog if possible (simple heuristic)
      const actionMatch = output.match(/^\*(.+?)\*/);
      const dialogMatch = output.match(/"(.+?)"/) || output.match(/(.+)$/);

      return {
        action: actionMatch ? actionMatch[1].trim() : null,
        dialog: dialogMatch ? dialogMatch[1].trim() : output.trim()
      };
    } catch (err) {
      console.warn("[NovelAIEngine] Failed:", err);
      return null; // triggers static fallback
    }
  }

  return { hasKey, setKey, getReply };
})();
