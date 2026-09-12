// A/B failover watchdog. The only process that decides when to flip which
// IMVU bot is running: polls the shared heartbeat file (imvu/failover.js)
// and, if the currently-active bot's heartbeat has gone stale, stops it and
// starts the standby bot via PM2 (by process name — both imvu-bot and
// imvu-bot-b are already registered with PM2, including their cwd/script,
// from their first manual start, so `pm2 start <name>` alone is enough).
//
// Deliberately does not touch IMVU credentials, cookies, or the IMVU client
// at all — this is pure process supervision on top of PM2.

const { execFile } = require('child_process');
const failover = require('./failover');

const POLL_INTERVAL_MS = 15000; // matches HEARTBEAT_INTERVAL_MS — no need to poll faster than heartbeats arrive

const BOT_PM2_NAME = { A: 'imvu-bot', B: 'imvu-bot-b' };

function pm2(args) {
    return new Promise((resolve) => {
        execFile('pm2', args, (err) => {
            if (err) console.error(`❌ [Watchdog] pm2 ${args.join(' ')} failed:`, err.message);
            resolve();
        });
    });
}

async function tick() {
    const state = failover.readState();
    if (!state || !state.active) return; // nothing claimed yet — wait for an operator to start a bot manually

    const now = Date.now();
    const heartbeatAge = now - (state.lastHeartbeat || 0);
    const claimAge = now - (state.claimedAt || 0);
    const sinceLastFailover = now - (state.lastFailoverAt || 0);

    if (heartbeatAge <= failover.FAILOVER_THRESHOLD_MS) return; // healthy
    if (claimAge < failover.MIN_ACTIVE_DURATION_MS) {
        console.log(`⏳ [Watchdog] Bot ${state.active} heartbeat stale (${Math.round(heartbeatAge / 1000)}s) but claim too young (${Math.round(claimAge / 1000)}s) — waiting.`);
        return;
    }
    if (sinceLastFailover < failover.FAILOVER_COOLDOWN_MS) {
        console.log(`⏳ [Watchdog] Bot ${state.active} heartbeat stale but failover cooldown active (${Math.round((failover.FAILOVER_COOLDOWN_MS - sinceLastFailover) / 1000)}s remaining) — waiting.`);
        return;
    }

    const failedBot = state.active;
    const standbyBot = failedBot === 'A' ? 'B' : 'A';

    console.log(`🚨 [Watchdog] Bot ${failedBot} heartbeat stale (${Math.round(heartbeatAge / 1000)}s, threshold ${failover.FAILOVER_THRESHOLD_MS / 1000}s) — failing over to Bot ${standbyBot}`);

    // Record the failover attempt before acting, so a watchdog crash
    // mid-failover can't erase the cooldown and cause a retry storm.
    failover.writeState({ ...state, lastFailoverAt: now });

    await pm2(['stop', BOT_PM2_NAME[failedBot]]);
    await pm2(['start', BOT_PM2_NAME[standbyBot]]);

    console.log(`✅ [Watchdog] Failover complete: ${BOT_PM2_NAME[failedBot]} stopped, ${BOT_PM2_NAME[standbyBot]} started`);
}

console.log(`🐕 [Watchdog] IMVU A/B failover watchdog starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
setInterval(() => {
    tick().catch((err) => console.error('❌ [Watchdog] tick error:', err.message));
}, POLL_INTERVAL_MS);
tick().catch((err) => console.error('❌ [Watchdog] initial tick error:', err.message));
