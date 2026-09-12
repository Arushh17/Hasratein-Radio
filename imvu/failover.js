// Shared A/B failover primitives used by imvu/bot.js (Bot A), imvu/bot-b.js
// (Bot B), and imvu/watchdog.js. Single responsibility: read/write the
// shared heartbeat/claim file both bots and the watchdog agree on, plus the
// timing constants that govern failover behavior. No IMVU-specific logic
// lives here — this file never touches credentials, cookies, or the IMVU
// client at all.
//
// State file shape: { active: 'A'|'B', claimedAt: <ms>, lastHeartbeat: <ms>,
// lastFailoverAt: <ms> }. Lives under database/, alongside this project's
// other shared cross-process JSON state (currentSong.json, queue.json, etc).

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../database/imvu-failover-state.json');

// How often the active bot writes a heartbeat.
const HEARTBEAT_INTERVAL_MS = 15000;

// A heartbeat older than this is considered stale (3x the interval — enough
// margin that a single missed tick or brief event-loop hiccup can't
// trigger a false failover).
const FAILOVER_THRESHOLD_MS = 45000;

// A claim younger than this is never failed over, even if its heartbeat
// looks stale — gives a freshly-promoted bot time to finish its own
// joinRoom()/subscribe sequence before it can be judged failed again.
const MIN_ACTIVE_DURATION_MS = 60000;

// Minimum spacing between watchdog-triggered failover actions, tracked
// persistently (survives a watchdog restart) — the main brake against
// rapid A/B flapping.
const FAILOVER_COOLDOWN_MS = 60000;

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function writeState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 4));
}

// Call once a bot has actually joined the room and subscribed successfully.
// Claims active status immediately, then keeps writing a fresh heartbeat on
// an interval for as long as this process runs. Returns a stop() function
// (not currently called anywhere, but kept for a clean shutdown hook).
function startHeartbeat(botId) {
    const now = Date.now();
    const previous = readState() || {};
    writeState({
        active: botId,
        claimedAt: now,
        lastHeartbeat: now,
        lastFailoverAt: previous.lastFailoverAt || 0,
    });
    console.log(`💓 [Failover] Bot ${botId} claimed active, heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

    const timer = setInterval(() => {
        const state = readState() || {};
        state.active = botId;
        state.claimedAt = state.claimedAt || now;
        state.lastHeartbeat = Date.now();
        writeState(state);
    }, HEARTBEAT_INTERVAL_MS);

    return () => clearInterval(timer);
}

// Defensive check a bot runs at its own startup, before joining the room:
// is the OTHER bot already claimed active with a fresh heartbeat? If so,
// this bot should NOT join, even if it was just started (manually, by an
// operator, or by PM2's own crash auto-restart) — the watchdog is the
// primary enforcer of "only one active", but this closes the gap for any
// path that starts a bot outside the watchdog's control.
function isOtherBotActiveAndFresh(botId) {
    const state = readState();
    if (!state || state.active === botId) return false;
    return (Date.now() - (state.lastHeartbeat || 0)) < FAILOVER_THRESHOLD_MS;
}

module.exports = {
    STATE_PATH,
    HEARTBEAT_INTERVAL_MS,
    FAILOVER_THRESHOLD_MS,
    MIN_ACTIVE_DURATION_MS,
    FAILOVER_COOLDOWN_MS,
    readState,
    writeState,
    startHeartbeat,
    isOtherBotActiveAndFresh,
};
