/* ═══════════════════════════════════════════════════════════════════
   INDEX.HTML INTEGRATION GUIDE FOR relationship.js
   Apply each section to index.html in the order shown.
   ═══════════════════════════════════════════════════════════════════ */


/* ─────────────────────────────────────────────────────────────────
   1. SCRIPT TAG — add in <head> BEFORE chat-engine.js
   ─────────────────────────────────────────────────────────────────
   <script src="relationship.js"></script>
   <script src="school-clock.js"></script>
   <script src="chat-engine.js"></script>
*/


/* ─────────────────────────────────────────────────────────────────
   2. CSS — paste inside <style>, before the closing </style>
   ─────────────────────────────────────────────────────────────────
*/
/*
── RELATIONSHIP UI ──────────────────────────────────────────────────
*/

/* Affinity bar container */
.rel-block        { margin-bottom: 12px; }
.rel-header-row   { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }

/* Level badge */
.rel-level-badge  {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 15px;
  letter-spacing: .1em;
  display: flex;
  align-items: center;
  gap: 5px;
}

/* Mood badge */
.rel-mood-badge   {
  font-family: 'Special Elite', serif;
  font-size: 11px;
  color: var(--muted);
  background: var(--cream);
  border-radius: 99px;
  padding: 2px 9px;
  letter-spacing: .03em;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Affinity bar */
.rel-bar-track    { height: 5px; background: var(--cream); border-radius: 3px; overflow: hidden; margin-bottom: 4px; }
.rel-bar-fill     { height: 100%; border-radius: 3px; transition: width .5s ease; }

/* Bar metadata row */
.rel-bar-meta     {
  display: flex;
  justify-content: space-between;
  font-family: 'DM Mono', monospace;
  font-size: 9px;
  color: var(--muted);
  margin-bottom: 6px;
}

/* Trust rate display */
.rel-trust-row    { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.rel-trust-label  { font-family: 'Special Elite', serif; font-size: 10px; color: var(--muted); }
.rel-trust-dots   { display: flex; gap: 3px; }
.rel-trust-dot    { width: 8px; height: 8px; border-radius: 50%; background: var(--cream); border: 1.5px solid var(--border); }
.rel-trust-dot.on { background: var(--gold); border-color: var(--gold); }

/* Interaction log */
.rel-log          { display: flex; flex-direction: column; gap: 4px; }
.rel-log-entry    {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'DM Mono', monospace;
  font-size: 10px;
  padding: 5px 8px;
  border-radius: 3px;
  background: var(--cream);
}
.rel-log-tone     { flex: 1; text-transform: capitalize; color: var(--ink); }
.rel-log-delta    { font-weight: 600; min-width: 30px; text-align: right; }
.rel-log-entry.pos .rel-log-delta { color: var(--green); }
.rel-log-entry.neg .rel-log-delta { color: var(--accent); }
.rel-log-entry.neu .rel-log-delta { color: var(--muted); }
.rel-log-time     { color: var(--muted); min-width: 40px; text-align: right; }
.rel-log-empty    { font-family: 'Special Elite', serif; font-size: 11px; color: var(--muted); font-style: italic; }

/* Level badge on roster cards */
.pc-level-badge   {
  position: absolute;
  top: 5px;
  right: 5px;
  font-size: 13px;
  line-height: 1;
}

/* Mood dot on roster cards */
.pc-mood-dot      {
  position: absolute;
  bottom: 6px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--border);
}


/* ─────────────────────────────────────────────────────────────────
   3. LS KEY — add inside the LS constant object in index.html
      (around line 760, inside the `const LS = { ... }` block)
   ─────────────────────────────────────────────────────────────────

   Find:
     const LS = {
       player:'hr2_player', chars:'hr2_chars', avatars:'hr2_avatars',
       homerooms:'hr2_homerooms', detention:'hr2_detention',
       locations:'hr2_locs', popularity:'hr2_pop'
     };

   Replace with:
     const LS = {
       player:'hr2_player', chars:'hr2_chars', avatars:'hr2_avatars',
       homerooms:'hr2_homerooms', detention:'hr2_detention',
       locations:'hr2_locs', popularity:'hr2_pop',
       relationships:'hr2_relationships'
     };
*/


/* ─────────────────────────────────────────────────────────────────
   4. INIT — wire Relationships into initApp()
      Find the end of the initApp() function (after ChatEngine.init call).
      Add these lines right after the characters/homerooms are populated:
   ─────────────────────────────────────────────────────────────────

   // ── Boot relationship engine ─────────────────────────────────
   if (typeof Relationships !== 'undefined') {
     Relationships.load();
     Relationships.init(characters);
   }
*/


/* ─────────────────────────────────────────────────────────────────
   5. PHASE HOOK — wire onPhaseChange into startClock()
      Inside the SchoolClock.onPhaseChange callback, add:
   ─────────────────────────────────────────────────────────────────

   SchoolClock.onPhaseChange(({ phase, date }) => {
     if (_activeChatRoom && typeof appendSystemMessage === 'function') {
       appendSystemMessage(`${phase.label} — ${date}`);
     }
     // NEW: Update all character moods for the new phase
     if (typeof Relationships !== 'undefined') {
       Relationships.onPhaseChange(phase.id);
     }
     placeAllStudents();
     if (currentView === 'map' || currentView === 'cafe') renderCurrentView();
   });
*/


/* ─────────────────────────────────────────────────────────────────
   6. CHAT SEND — replace the chatSend() function entirely
   ─────────────────────────────────────────────────────────────────
*/
function chatSend() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !_activeChatRoom) return;

  if (typeof ChatEngine !== 'undefined') {
    ChatEngine.sendMessage(_activeChatRoom, text);
  }

  // ── Relationship processing ──────────────────────────────────
  if (typeof Relationships !== 'undefined') {
    // Find who's in this room (class rooms use homerooms; zones use locations)
    let roster = homerooms[_activeChatRoom] || [];
    if (roster.length === 0) {
      roster = Object.keys(characters).filter(cid => locations[cid] === _activeChatRoom);
    }

    // Detect @mention for a direct interaction
    let directCharId = null;
    const mentionMatch = text.match(/@([\w\s'-]+)/i);
    if (mentionMatch) {
      const query = mentionMatch[1].trim().toLowerCase();
      directCharId = roster.find(id => {
        const name = (characters[id]?.name || '').toLowerCase();
        return name.startsWith(query) || name.includes(query);
      }) || null;
    }

    // Process affinity for all room characters
    roster.forEach(cid => {
      const isDirect = (cid === directCharId);
      const result   = Relationships.processMessage(cid, text, isDirect);

      // Toast on level-up for direct target
      if (result.levelChanged && isDirect) {
        const lv = result.levelAfter;
        showToast(`${characters[cid]?.name || cid} — ${lv.icon} ${lv.label}`);
      }
    });
  }

  input.value       = '';
  input.style.height = '';
}


/* ─────────────────────────────────────────────────────────────────
   7. PROFILE MODAL — replace openProfileModal() entirely
   ─────────────────────────────────────────────────────────────────
*/
function openProfileModal(cid) {
  const c = characters[cid];
  if (!c) return;
  const content = document.getElementById('profile-modal-content');

  // ── Build relationship block (if engine is loaded) ────────────
  let relHTML = '';
  if (typeof Relationships !== 'undefined') {
    const affinity  = Relationships.getAffinity(cid);
    const level     = Relationships.getLevel(cid);
    const mood      = Relationships.getMood(cid);
    const trustRate = Relationships.getTrustRate(cid);
    const trustLbl  = Relationships.getTrustLabel(cid);
    const log       = (Relationships._debug.state()[cid]?.log || []).slice(0, 5);
    const levels    = Relationships.getLevels();

    // Affinity bar: width as pct of the current level band
    const prevAt  = level.n > 0 ? levels[level.n - 1].nextAt : 0;
    const nextAt  = level.nextAt < 101 ? level.nextAt : 100;
    const bandW   = Math.max(nextAt - prevAt, 1);
    const pct     = level.n >= 6 ? 100 : Math.round(((affinity - prevAt) / bandW) * 100);

    // Trust dots (5 dots, filled based on rate mapped 0.2–2.0 → 0–5)
    const dotsFilled = Math.round(((trustRate - 0.2) / 1.8) * 5);
    const trustDots  = [0,1,2,3,4].map(i =>
      `<div class="rel-trust-dot${i < dotsFilled ? ' on' : ''}"></div>`
    ).join('');

    // Interaction log rows
    function _toneIcon(tone) {
      return Relationships.getToneIcon(tone);
    }
    function _timeAgo(ts) {
      const mins = Math.round((Date.now() - ts) / 60000);
      if (mins < 1)  return 'just now';
      if (mins < 60) return `${mins}m ago`;
      return `${Math.round(mins/60)}h ago`;
    }

    const logRows = log.length === 0
      ? `<div class="rel-log-empty">No interactions recorded yet.</div>`
      : log.map(e => {
          const sign   = e.delta > 0 ? '+' : '';
          const cls    = e.delta > 0 ? 'pos' : e.delta < 0 ? 'neg' : 'neu';
          return `
            <div class="rel-log-entry ${cls}">
              <span class="rel-log-tone">${_toneIcon(e.tone)} ${e.tone}</span>
              <span class="rel-log-delta">${sign}${e.delta}</span>
              <span class="rel-log-time">${_timeAgo(e.ts)}</span>
            </div>`;
        }).join('');

    relHTML = `
      <div class="pd-section rel-block">
        <div class="pd-sect-title">Relationship Status</div>
        <div class="rel-header-row">
          <div class="rel-level-badge" style="color:${level.color}">
            ${level.icon} ${level.label}
          </div>
          <div class="rel-mood-badge">
            ${mood.icon} ${mood.label}
          </div>
        </div>
        <div class="rel-bar-track">
          <div class="rel-bar-fill" style="width:${pct}%;background:${level.color}"></div>
        </div>
        <div class="rel-bar-meta">
          <span>${affinity} affinity</span>
          <span>${level.nextAt < 101 ? `${level.nextAt - affinity} to ${levels[level.n + 1]?.label || 'max'}` : '✦ Bond reached'}</span>
        </div>
        <div class="rel-trust-row">
          <span class="rel-trust-label">Opens up:</span>
          <div class="rel-trust-dots">${trustDots}</div>
          <span class="rel-trust-label">${trustLbl}</span>
        </div>
      </div>
      <div class="pd-section">
        <div class="pd-sect-title">Interaction History</div>
        <div class="rel-log">${logRows}</div>
      </div>`;
  }

  content.innerHTML = `
    <div class="m-title">Student Record</div>
    <div class="pd-hero">
      <div id="modal-av-placeholder"></div>
      <div>
        <div class="pd-name">${c.name}</div>
        ${c.series ? `<div class="pd-class">${c.series}</div>` : ''}
        <div class="pd-tags"></div>
      </div>
    </div>
    ${relHTML}
    <div class="pd-section">
      <div class="pd-sect-title">Behavioral Summary & Diagnostics</div>
      <div style="font-family:'Special Elite',serif; font-size:11px; color:var(--muted); line-height:1.6;">
        ${buildProfileBlurb(c)}
      </div>
    </div>
    <div class="pd-actions">
      <button class="pd-act-btn" onclick="toggleDetention('${cid}')">${detention[cid] ? 'Clear Profile' : 'Flag Disciplinary Actions'}</button>
      <button class="pd-act-btn" onclick="closeOverlay('profile-modal')">Close Window</button>
    </div>
  `;

  content.querySelector('#modal-av-placeholder').appendChild(makeAv(cid, 72));
  const tagsWrap = content.querySelector('.pd-tags');
  (c.tags || []).forEach(t => {
    const ts = document.createElement('span');
    ts.className = 'pd-tag';
    ts.textContent = t;
    tagsWrap.appendChild(ts);
  });

  openOverlay('profile-modal');
}


/* ─────────────────────────────────────────────────────────────────
   8. ROSTER RENDER — replace renderRoster() entirely
      Adds level badge + mood dot to each roster card.
   ─────────────────────────────────────────────────────────────────
*/
function renderRoster() {
  const grid = document.getElementById('roster-grid');
  grid.innerHTML = '';

  // Sort by affinity descending so friends appear first
  const sorted = Object.keys(characters).sort((a, b) => {
    const afA = typeof Relationships !== 'undefined' ? Relationships.getAffinity(a) : 0;
    const afB = typeof Relationships !== 'undefined' ? Relationships.getAffinity(b) : 0;
    return afB - afA;
  });

  sorted.forEach(cid => {
    const c    = characters[cid];
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.style.position = 'relative';
    card.appendChild(makeAv(cid, 54));

    const name = document.createElement('div');
    name.className = 'pc-name';
    name.textContent = c.name;
    card.appendChild(name);

    // ── Relationship overlays ──────────────────────────────────
    if (typeof Relationships !== 'undefined') {
      const level = Relationships.getLevel(cid);
      const mood  = Relationships.getMood(cid);

      // Level badge (top-right corner)
      if (level.n > 0) {
        const badge = document.createElement('div');
        badge.className = 'pc-level-badge';
        badge.title = level.label;
        badge.textContent = level.icon;
        card.appendChild(badge);
      }

      // Mood dot (bottom-right corner), colored by valence
      const moodColors = {
        elated: '#c9992a', happy: '#7aaa3a', energized: '#4a8aaa',
        playful: '#c07830', focused: '#264e73', neutral: '#9a9a9a',
        restless: '#d4621a', brooding: '#6b3fa0', withdrawn: '#5a5a7a', irritated: '#c53030',
      };
      const dot = document.createElement('div');
      dot.className = 'pc-mood-dot';
      dot.style.background = moodColors[mood.id] || '#9a9a9a';
      dot.title = mood.label;
      card.appendChild(dot);
    }

    card.onclick = () => openProfileModal(cid);
    grid.appendChild(card);
  });
}
