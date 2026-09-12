// Bot B (Tanish10) — a completely independent IMVU session from Bot A
// (imvu/bot.js). Same logic/behavior as Bot A today, adapted to Bot B's own
// credentials. No heartbeat/failover wiring yet — this script only proves
// Bot B can log in and join the room on its own, in isolation from Bot A.
//
// Isolation from Bot A is achieved by running this process with a DIFFERENT
// working directory (PM2 --cwd), not by anything in this file: the IMVU
// client's cookie jar is a hardcoded './cookies.json' relative to
// process.cwd() (see imvu-next-tool/packages/client/src/client/Client.ts),
// so a distinct cwd gives Bot B a completely separate cookie file
// automatically, with zero risk of colliding with Bot A's session.

require('dotenv').config({
    path: require('path').join(__dirname, '../imvu-next-tool/.env')
});

const { Client } = require('../imvu-next-tool/packages/client/dist/cjs/index.js');
const { createIMQManager } = require('../imvu-next-tool/packages/imq/dist/cjs/index.js');
const { handleCommand } = require('../bot/bot');
const failover = require('./failover');

const { IMVU_BOTB_USERNAME, IMVU_BOTB_PASSWORD, IMVU_ROOM_ID, IMVU_BOTB_VERIFICATION_CODE } = process.env;

if (!IMVU_BOTB_USERNAME || !IMVU_BOTB_PASSWORD) {
    console.error('❌ [Bot B] IMVU_BOTB_USERNAME and IMVU_BOTB_PASSWORD must be set in imvu-next-tool/.env');
    process.exit(1);
}

if (!IMVU_ROOM_ID) {
    console.error('❌ [Bot B] IMVU_ROOM_ID must be set in imvu-next-tool/.env (e.g. 286257857-24)');
    process.exit(1);
}

async function start() {
    console.log('🤖 [Bot B] Hasratein Radio IMVU bridge starting...');

    const client = new Client();

    // Same verification-code mechanism as Bot A: supplied via env var only,
    // never hard-coded, never logged.
    const loginOptions = IMVU_BOTB_VERIFICATION_CODE ? { twoFactorCode: IMVU_BOTB_VERIFICATION_CODE } : {};
    console.log(`🔐 [Bot B] Verification code supplied: ${IMVU_BOTB_VERIFICATION_CODE ? 'yes' : 'no'}`);

    try {
        await client.login(IMVU_BOTB_USERNAME, IMVU_BOTB_PASSWORD, loginOptions);
    } catch (err) {
        const message = (err && err.message) || '';
        const needsCode = /emailed|verification code|2fa/i.test(message);

        if (needsCode) {
            console.error(`❌ [Bot B] IMVU login requires a verification code: ${message}`);
            console.error(IMVU_BOTB_VERIFICATION_CODE
                ? '❌ [Bot B] The supplied IMVU_BOTB_VERIFICATION_CODE was rejected or has expired.'
                : '❌ [Bot B] Set IMVU_BOTB_VERIFICATION_CODE in imvu-next-tool/.env to the code IMVU emailed, then restart Bot B.');
            console.error('⏸ [Bot B] Staying idle (not exiting) to avoid a restart crash-loop.');
            await new Promise(() => {}); // idle forever; no retries, no exit
            return;
        }

        throw err;
    }

    console.log('✅ [Bot B] IMVU logged in');

    const cid = client.cid;
    const manager = createIMQManager(client, String(cid));
    await manager.connect();
    console.log('✅ [Bot B] IMQ connected');

    manager.connection.config.onRawFrame = (frame) => {
        const data = Buffer.isBuffer(frame.data) ? frame.data.toString() : frame.data;
        console.log(`🔍 [Bot B] RAW [${frame.direction}]:`, data);
    };

    // Resolve room → chat resource → IMQ queue, and join it (participants
    // POST). Identical mechanism to Bot A's joinRoom().
    async function joinRoom() {
        const room = await client.rooms.fetch(IMVU_ROOM_ID);
        const chatUrl = room.relations.chat;
        const rawChat = await client.resource(chatUrl.replace('https://api.imvu.com', ''));
        const queue = rawChat.data.imq_queue;
        const mount = rawChat.data.imq_messages_mount;

        console.log(`📡 [Bot B] Subscribed to room ${IMVU_ROOM_ID} | queue: ${queue} | mount: ${mount}`);

        const participantsUrl = rawChat.relations && rawChat.relations.participants;
        console.log(`🚪 [Bot B] Participants collection URL: ${participantsUrl || '(none found on chat resource)'}`);

        if (participantsUrl) {
            try {
                const participantsPath = participantsUrl.replace('https://api.imvu.com', '');
                const joinResponse = await client.request(participantsPath, { method: 'POST', data: {} });
                const denormalizedKeys = joinResponse && joinResponse.denormalized ? Object.keys(joinResponse.denormalized) : [];
                console.log(`✅ [Bot B] Participants POST succeeded — status: ${joinResponse && joinResponse.status}, id: ${joinResponse && joinResponse.id}`);
                console.log(`🚪 [Bot B] Participants POST denormalized keys: ${JSON.stringify(denormalizedKeys)}`);
            } catch (err) {
                console.error(`❌ [Bot B] Participants POST failed: ${err.message}`);
            }
        }

        return { queue, mount };
    }

    // Defensive backstop (the watchdog is the primary enforcer): if the
    // other bot already holds a fresh active claim, don't join — covers
    // any path that starts this process outside the watchdog's control
    // (a manual start, or PM2's own crash auto-restart).
    if (failover.isOtherBotActiveAndFresh('B')) {
        console.log('⏸ [Failover] [Bot B] Bot A is already active and healthy — staying idle instead of joining.');
        await new Promise(() => {});
        return;
    }

    let { queue: imqQueue, mount: imqMount } = await joinRoom();

    function sendReply(text) {
        const chatId = imqQueue.replace('/chat/', '');
        manager.sendMessage(imqQueue, imqMount, { chatId, message: text, to: 0, userId: String(cid) });
    }

    function onRoomMessage(msg) {
        const text = (msg.message && msg.message.message) ? msg.message.message.trim() : '';
        if (!text.startsWith('!')) return;
        console.log(`💬 [Bot B] IMVU command from ${msg.user_id}: ${text}`);
        handleCommand(text, sendReply, IMVU_ROOM_ID).catch((err) => console.error('❌ [Bot B] handleCommand error:', err));
    }

    function subscribe() {
        manager.subscribeMessage(imqQueue, imqMount, (_err, mount) => {
            mount.removeAllListeners('message');
            mount.on('message', onRoomMessage);
        });
    }

    let rejoining = false;
    let lastRecoveryAttemptAt = 0;
    const RECOVERY_COOLDOWN_MS = 30000;

    function subscribeParticipants() {
        manager.subscribeState(imqQueue, 'participants', (_err, mount) => {
            mount.removeAllListeners('stateChange');
            mount.removeAllListeners('subscriberUpdate');
            mount.on('stateChange', (data) => {
                console.log('👥 [Bot B] participants stateChange:', JSON.stringify(data));
            });
            mount.on('subscriberUpdate', (data) => {
                console.log('👥 [Bot B] participants subscriberUpdate:', JSON.stringify(data));

                if (data && data.action === 'left' && String(data.user_id) === String(cid)
                    && data.queue === imqQueue && !rejoining) {
                    const sinceLastAttempt = Date.now() - lastRecoveryAttemptAt;
                    if (sinceLastAttempt < RECOVERY_COOLDOWN_MS) {
                        console.log(`⏳ [Bot B] Drop detected but recovery cooldown active (${Math.ceil((RECOVERY_COOLDOWN_MS - sinceLastAttempt) / 1000)}s remaining) — skipping this attempt.`);
                        return;
                    }

                    rejoining = true;
                    lastRecoveryAttemptAt = Date.now();
                    const oldQueue = imqQueue;
                    console.log(`🔁 [Bot B] Detected our own drop from ${oldQueue} — re-fetching chat resource to rejoin...`);
                    joinRoom().then(({ queue, mount: newMount }) => {
                        console.log(`🔁 [Bot B] Fresh queue obtained: ${oldQueue} → ${queue}`);
                        imqQueue = queue;
                        imqMount = newMount;
                        subscribe();
                        subscribeParticipants();
                        console.log(`✅ [Bot B] Rejoined room ${IMVU_ROOM_ID} on fresh queue ${imqQueue}`);
                        rejoining = false;
                    }).catch((err) => {
                        console.error(`❌ [Bot B] Rejoin after drop failed: ${err.message}`);
                        rejoining = false;
                    });
                }
            });
        });
    }

    subscribe();
    subscribeParticipants();

    // We've successfully joined and subscribed — claim active status and
    // start heartbeating so the watchdog (and Bot A's own startup check)
    // know Bot B is the one intentionally in the room.
    failover.startHeartbeat('B');

    manager.connection.on('state', (status) => {
        if (status === 3) {
            console.log(`📡 [Bot B] Re-subscribing to room ${IMVU_ROOM_ID} after reconnect`);
            subscribe();
            subscribeParticipants();
        }
    });
}

start().catch((err) => {
    console.error('❌ [Bot B] IMVU bridge error:', err);
    process.exit(1);
});
