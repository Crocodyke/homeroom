// ═══════════════════════════════════════════════════════════════════
// SCHOOL CLOCK — Real-time school day phase system
// Mirrors the real-world clock. No acceleration.
// ═══════════════════════════════════════════════════════════════════

const SchoolClock = (() => {

  // ── SCHEDULE ────────────────────────────────────────────────────
  // Each entry: { id, label, start, end, inClass }
  // start/end are [hour, minute] 24-hour
  // inClass: whether students are in assigned classrooms

  const WEEKDAY_PHASES = [
    { id: 'night',       label: 'Night',          start: [0,  0], end: [6,  59], inClass: false },
    { id: 'arrival',     label: 'Morning Arrival', start: [7,  0], end: [7,  59], inClass: false },
    { id: 'homeroom',    label: 'Homeroom',        start: [8,  0], end: [8,  14], inClass: true  },
    { id: 'period1',     label: 'Period 1',        start: [8, 15], end: [9,  44], inClass: true  },
    { id: 'break1',      label: 'Break',           start: [9, 45], end: [9,  59], inClass: false },
    { id: 'period2',     label: 'Period 2',        start: [10, 0], end: [11, 29], inClass: true  },
    { id: 'lunch',       label: 'Lunch',           start: [11,30], end: [12, 14], inClass: false },
    { id: 'period3',     label: 'Period 3',        start: [12,15], end: [13, 44], inClass: true  },
    { id: 'break2',      label: 'Break',           start: [13,45], end: [13, 59], inClass: false },
    { id: 'period4',     label: 'Period 4',        start: [14, 0], end: [15, 29], inClass: true  },
    { id: 'afterschool', label: 'After School',    start: [15,30], end: [22, 59], inClass: false },
    { id: 'curfew',      label: 'Curfew',          start: [23, 0], end: [23, 59], inClass: false },
  ];

  const WEEKEND_PHASES = [
    { id: 'night',    label: 'Night',       start: [0,  0], end: [8,  59], inClass: false },
    { id: 'freeday',  label: 'Free Day',    start: [9,  0], end: [22, 59], inClass: false },
    { id: 'curfew',   label: 'Curfew',      start: [23, 0], end: [23, 59], inClass: false },
  ];

  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];

  // ── INTERNAL STATE ──────────────────────────────────────────────
  let _tickInterval   = null;
  let _lastPhaseId    = null;
  let _onTickCbs      = [];
  let _onPhaseCbs     = [];

  // ── HELPERS ─────────────────────────────────────────────────────
  function _toMinutes(h, m) { return h * 60 + m; }

  function _getPhase(now) {
    const dow = now.getDay(); // 0=Sun, 6=Sat
    const isWeekend = (dow === 0 || dow === 6);
    const phases = isWeekend ? WEEKEND_PHASES : WEEKDAY_PHASES;
    const cur = _toMinutes(now.getHours(), now.getMinutes());

    for (const p of phases) {
      const s = _toMinutes(p.start[0], p.start[1]);
      const e = _toMinutes(p.end[0],   p.end[1]);
      if (cur >= s && cur <= e) return p;
    }
    // fallback
    return phases[0];
  }

  function _formatTime(now) {
    let h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }

  function _formatDate(now) {
    const day  = DAY_NAMES[now.getDay()];
    const mon  = MONTH_NAMES[now.getMonth()];
    const date = now.getDate();
    return `${day}, ${mon} ${date}`;
  }

  // ── TICK ────────────────────────────────────────────────────────
  function _tick() {
    const now   = new Date();
    const phase = _getPhase(now);
    const time  = _formatTime(now);
    const date  = _formatDate(now);
    const isWeekend = (now.getDay() === 0 || now.getDay() === 6);

    // Update topbar elements
    const tbTime   = document.getElementById('tb-time');
    const tbPeriod = document.getElementById('tb-period');
    if (tbTime)   tbTime.textContent   = time;
    if (tbPeriod) tbPeriod.textContent = phase.label;

    // Fire phase-change callbacks
    if (phase.id !== _lastPhaseId) {
      _lastPhaseId = phase.id;
      _onPhaseCbs.forEach(cb => {
        try { cb({ phase, now, date, isWeekend }); } catch(e) {}
      });
    }

    // Fire tick callbacks
    _onTickCbs.forEach(cb => {
      try { cb({ phase, now, time, date, isWeekend }); } catch(e) {}
    });
  }

  // ── PUBLIC API ──────────────────────────────────────────────────
  function start() {
    _tick(); // immediate first tick
    _tickInterval = setInterval(_tick, 15000); // re-check every 15s
  }

  function stop() {
    if (_tickInterval) clearInterval(_tickInterval);
    _tickInterval = null;
  }

  /** Returns the current schedule state object. */
  function getState() {
    const now       = new Date();
    const phase     = _getPhase(now);
    const isWeekend = (now.getDay() === 0 || now.getDay() === 6);
    return {
      phase,
      now,
      time:      _formatTime(now),
      date:      _formatDate(now),
      isWeekend,
      inClass:   phase.inClass,
      phaseId:   phase.id,
      phaseLabel: phase.label,
      isNight:   (phase.id === 'night'),
      isLunch:   (phase.id === 'lunch'),
      isAfterSchool: (phase.id === 'afterschool'),
      isCurfew:  (phase.id === 'curfew'),
    };
  }

  /**
   * Returns the current period number (1-4) if in a class period,
   * or null otherwise.
   */
  function getCurrentPeriodNumber() {
    const { phaseId } = getState();
    const map = { period1: 1, period2: 2, period3: 3, period4: 4, homeroom: 0 };
    return map[phaseId] !== undefined ? map[phaseId] : null;
  }

  /** Register a callback called every ~15s tick. */
  function onTick(cb)        { _onTickCbs.push(cb); }

  /** Register a callback called only when the phase changes. */
  function onPhaseChange(cb) { _onPhaseCbs.push(cb); }

  /** Returns all phases for display in the schedule strip. */
  function getWeekdayPhases()  { return WEEKDAY_PHASES; }
  function getWeekendPhases()  { return WEEKEND_PHASES; }

  return { start, stop, getState, getCurrentPeriodNumber, onTick, onPhaseChange, getWeekdayPhases, getWeekendPhases };

})();
