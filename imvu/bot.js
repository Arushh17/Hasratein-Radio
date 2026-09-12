require('dotenv').config({
    path: require('path').join(__dirname, '../imvu-next-tool/.env')
});

const { Client } = require('../imvu-next-tool/packages/client/dist/cjs/index.js');
const { createIMQManager } = require('../imvu-next-tool/packages/imq/dist/cjs/index.js');
const { handleCommand } = require('../bot/bot');
const failover = require('./failover');

const { IMVU_USERNAME, IMVU_PASSWORD, IMVU_ROOM_ID, IMVU_VERIFICATION_CODE } = process.env;

if (!IMVU_USERNAME || !IMVU_PASSWORD) {
    console.error('❌ IMVU_USERNAME and IMVU_PASSWORD must be set in imvu-next-tool/.env');
    process.exit(1);
}

if (!IMVU_ROOM_ID) {
    console.error('❌ IMVU_ROOM_ID must be set in imvu-next-tool/.env (e.g. 286257857-24)');
    process.exit(1);
}

async function start() {
    console.log('🤖 Hasratein Radio IMVU bridge starting...');

    const client = new Client();

    // If IMVU is requiring an emailed verification/2FA code for this login
    // (e.g. after a stale session was cleared), it's supplied via the
    // IMVU_VERIFICATION_CODE env var — never hard-coded — and passed
    // through the client's existing twoFactorCode option (sent as
    // '2fa_code' in the login POST). Its value is never logged.
    const loginOptions = IMVU_VERIFICATION_CODE ? { twoFactorCode: IMVU_VERIFICATION_CODE } : {};
    console.log(`🔐 Verification code supplied: ${IMVU_VERIFICATION_CODE ? 'yes' : 'no'}`);

    try {
        await client.login(IMVU_USERNAME, IMVU_PASSWORD, loginOptions);
    } catch (err) {
        const message = (err && err.message) || '';
        const needsCode = /emailed|verification code|2fa/i.test(message);

        if (needsCode) {
            // Known, specific failure: IMVU wants a code we don't have (or
            // the one we sent was wrong/expired). Do NOT rethrow — the
            // top-level start().catch() below calls process.exit(1), which
            // PM2 turns into an immediate restart, which repeats this same
            // login and can trigger further verification emails. Log
            // clearly and stay idle instead, so PM2 sees a running (not
            // crash-looping) process until this is fixed and restarted
            // deliberately.
            console.error(`❌ IMVU login requires a verification code: ${message}`);
            console.error(IMVU_VERIFICATION_CODE
                ? '❌ The supplied IMVU_VERIFICATION_CODE was rejected or has expired.'
                : '❌ Set IMVU_VERIFICATION_CODE in imvu-next-tool/.env to the code IMVU emailed, then restart imvu-bot.');
            console.error('⏸ Staying idle (not exiting) to avoid a restart crash-loop.');
            await new Promise(() => {}); // idle forever; no retries, no exit
            return;
        }

        throw err; // anything else: unchanged behavior, handled by start().catch() below
    }

    console.log('✅ IMVU logged in');

    const cid = client.cid;
    const manager = createIMQManager(client, String(cid));
    await manager.connect();
    console.log('✅ IMQ connected');

    manager.connection.config.onRawFrame = (frame) => {
        const data = Buffer.isBuffer(frame.data) ? frame.data.toString() : frame.data;
        console.log(`🔍 RAW [${frame.direction}]:`, data);
    };

    // Resolve room → chat resource → IMQ queue, and join it (participants
    // POST). Extracted into a function, unchanged in behavior from before,
    // so recovery below can redo the exact same join to get a fresh queue.
    async function joinRoom() {
        const room = await client.rooms.fetch(IMVU_ROOM_ID);
        const chatUrl = room.relations.chat;
        const rawChat = await client.resource(chatUrl.replace('https://api.imvu.com', ''));
        const queue = rawChat.data.imq_queue;
        const mount = rawChat.data.imq_messages_mount;

        console.log(`📡 Subscribed to room ${IMVU_ROOM_ID} | queue: ${queue} | mount: ${mount}`);

        // Real room-entry mechanism, per the IMVU Next client bundle: joining a
        // room means POSTing an empty body to the chat's "participants" edge
        // collection. Failure here is logged, not fatal.
        const participantsUrl = rawChat.relations && rawChat.relations.participants;
        console.log(`🚪 Participants collection URL: ${participantsUrl || '(none found on chat resource)'}`);

        if (participantsUrl) {
            try {
                const participantsPath = participantsUrl.replace('https://api.imvu.com', '');
                const joinResponse = await client.request(participantsPath, { method: 'POST', data: {} });
                const denormalizedKeys = joinResponse && joinResponse.denormalized ? Object.keys(joinResponse.denormalized) : [];
                console.log(`✅ Participants POST succeeded — status: ${joinResponse && joinResponse.status}, id: ${joinResponse && joinResponse.id}`);
                console.log(`🚪 Participants POST denormalized keys: ${JSON.stringify(denormalizedKeys)}`);
                if (joinResponse && joinResponse.id && joinResponse.denormalized && joinResponse.denormalized[joinResponse.id]) {
                    const created = joinResponse.denormalized[joinResponse.id];
                    console.log(`🚪 Created participant data keys: ${JSON.stringify(Object.keys(created.data || {}))}`);
                    console.log(`🚪 Created participant relations keys: ${JSON.stringify(Object.keys(created.relations || {}))}`);
                }
            } catch (err) {
                console.error(`❌ Participants POST failed: ${err.message}`);
            }
        }

        return { queue, mount };
    }

    // Defensive backstop (the watchdog is the primary enforcer): if the
    // other bot already holds a fresh active claim, don't join — covers
    // any path that starts this process outside the watchdog's control
    // (a manual start, or PM2's own crash auto-restart).
    if (failover.isOtherBotActiveAndFresh('A')) {
        console.log('⏸ [Failover] Bot B is already active and healthy — staying idle instead of joining.');
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
        console.log(`💬 IMVU command from ${msg.user_id}: ${text}`);
        handleCommand(text, sendReply, IMVU_ROOM_ID).catch((err) => console.error('❌ handleCommand error:', err));
    }

    function subscribe() {
        manager.subscribeMessage(imqQueue, imqMount, (_err, mount) => {
            mount.removeAllListeners('message');
            mount.on('message', onRoomMessage);
        });
    }

    // Observation-only: listen for the presence/occupancy state mount.
    // Evidence from the bot's own IMQ history shows every real mount
    // ("messages", "web_msg") and every real inbound frame has only ever
    // appeared on the personal /user/<cid> queue (auto-joined on connect) —
    // never on the room-derived /chat/<id> queue, which has produced zero
    // inbound traffic across every session captured so far. So this
    // subscribes on the personal queue instead of imqQueue.
    const userQueue = `/user/${cid}`;

    function subscribeHangoutState() {
        manager.subscribeState(userQueue, 'hangout_state_mount', (_err, mount) => {
            mount.removeAllListeners('stateChange');
            mount.removeAllListeners('subscriberUpdate');
            mount.on('stateChange', (data) => {
                console.log('🪑 hangout_state_mount stateChange:', JSON.stringify(data));
            });
            mount.on('subscriberUpdate', (data) => {
                console.log('👤 hangout_state_mount subscriberUpdate:', JSON.stringify(data));
            });
        });
    }

    // Observation-only: listen for the real "participants" state mount on the
    // joined chat's own queue (confirmed live via msg_g2c_create_mount type 2
    // right after the participants POST). Does not touch the join POST above
    // or the chat message subscription/handling.
    let rejoining = false;
    let lastRecoveryAttemptAt = 0;
    const RECOVERY_COOLDOWN_MS = 30000; // minimum time between joinRoom() recovery attempts

    function subscribeParticipants() {
        manager.subscribeState(imqQueue, 'participants', (_err, mount) => {
            mount.removeAllListeners('stateChange');
            mount.removeAllListeners('subscriberUpdate');
            mount.on('stateChange', (data) => {
                console.log('👥 participants stateChange:', JSON.stringify(data));
                const found = JSON.stringify(data && data.state || '').includes(String(cid));
                console.log(found
                    ? `✅ user-${cid} FOUND in participants state`
                    : `⚠️ user-${cid} NOT found in participants state`);
            });
            mount.on('subscriberUpdate', (data) => {
                console.log('👥 participants subscriberUpdate:', JSON.stringify(data));

                // Recovery: the server can drop our own subscription to this
                // single-use chat queue without a full IMQ reconnect. The
                // IMQManager-level fix resends msg_c2g_subscribe for the SAME
                // queue, but that queue doesn't get re-honored once dropped —
                // a fresh queue is needed instead. Detect it's specifically
                // OUR OWN "left" on the queue we're CURRENTLY using (guards
                // against an orphaned old-queue listener firing after we've
                // already moved on), then redo the exact original join.
                if (data && data.action === 'left' && String(data.user_id) === String(cid)
                    && data.queue === imqQueue && !rejoining) {
                    const sinceLastAttempt = Date.now() - lastRecoveryAttemptAt;
                    if (sinceLastAttempt < RECOVERY_COOLDOWN_MS) {
                        console.log(`⏳ Drop detected but recovery cooldown active (${Math.ceil((RECOVERY_COOLDOWN_MS - sinceLastAttempt) / 1000)}s remaining) — skipping this attempt.`);
                        return;
                    }

                    rejoining = true;
                    lastRecoveryAttemptAt = Date.now();
                    const oldQueue = imqQueue;
                    console.log(`🔁 Detected our own drop from ${oldQueue} — re-fetching chat resource to rejoin...`);
                    joinRoom().then(({ queue, mount: newMount }) => {
                        console.log(`🔁 Fresh queue obtained: ${oldQueue} → ${queue}`);
                        imqQueue = queue;
                        imqMount = newMount;
                        subscribe();
                        subscribeParticipants();
                        console.log(`✅ Rejoined room ${IMVU_ROOM_ID} on fresh queue ${imqQueue}`);
                        rejoining = false;
                    }).catch((err) => {
                        console.error(`❌ Rejoin after drop failed: ${err.message}`);
                        rejoining = false;
                    });
                }
            });
        });
    }

    // Initial subscription (runs immediately — connection is already AUTHENTICATED here).
    subscribe();
    subscribeHangoutState();
    subscribeParticipants();

    // We've successfully joined and subscribed — claim active status and
    // start heartbeating so the watchdog (and Bot B's own startup check)
    // know Bot A is the one intentionally in the room.
    failover.startHeartbeat('A');

    // Re-subscribe after every reconnect. Status 3 = AUTHENTICATED in IMQConnection.
    manager.connection.on('state', (status) => {
        if (status === 3) {
            console.log(`📡 Re-subscribing to room ${IMVU_ROOM_ID} after reconnect`);
            subscribe();
            subscribeHangoutState();
            subscribeParticipants();
        }
    });
}

start().catch((err) => {
    console.error('❌ IMVU bridge error:', err);
    process.exit(1);
});
