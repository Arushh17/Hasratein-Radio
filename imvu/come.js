// Shared !come implementation used by BOTH Bot A (imvu/bot.js) and Bot B
// (imvu/bot-b.js), so an A/B failover never silently disables the command.
// Extracted verbatim (behavior-preserving) from imvu/bot.js's original
// inline implementation — see git history on that file for the full
// verified-protocol writeup this is based on.
//
// Owner/moderator-only (IMVU_COME_ALLOWED_USERIDS allow-list). Disabled by
// default (IMVU_COME_ENABLED) — deployed but inactive until enabled.
//
// Mechanism (verified against real IMVU Next traffic, not guessed):
//   1. Read the sender's OWN participant resource:
//        GET /chat/chat-<roomId>/participants/user-<senderCid>
//   2. Reuse the sender's {seat_furni_id, seat_number} in a POST to the
//      calling bot's OWN participant resource — the exact request shape
//      captured live from the real IMVU Next client:
//        POST /chat/chat-<roomId>/participants/user-<botCid>
//        { "seat_furni_id": "<id>", "seat_number": <n> }
//   No preset locations, no node map, no calibration data of any kind — the
//   sender's current seat is read fresh on every invocation.
//
// Limitation (proven, not assumed): this only works if the sender is
// currently seated on real furniture. A user standing/walking on open floor
// has seat_furni_id 0 (no furniture) — IMVU does not expose free-floor
// world position through this resource, and this deliberately refuses that
// case rather than fabricate a "nearest guess".

const IMVU_COME_ENABLED = process.env.IMVU_COME_ENABLED === 'true';
const IMVU_COME_ALLOWED_USERIDS = new Set(
    (process.env.IMVU_COME_ALLOWED_USERIDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);
const COME_COOLDOWN_MS = 10000; // 10 seconds, per agreed spec

const UNAUTHORIZED_MESSAGE = "You don't have permission for this command.";

// resolveComeDestination() is the single isolated point that decides
// whether a sender's captured participant data yields a usable !come
// destination, and what it is. Kept separate from the network calls/reply
// dispatch specifically so that IF IMVU ever exposes a real world-position/
// open-floor movement mechanism, only this one function needs to change —
// the GET/POST/verify/reply pipeline around it stays untouched.
//
// Today it only recognizes real furniture seats (proven, working
// mechanism). Open floor (seat_furni_id "0") is deliberately treated as
// unresolvable, not approximated: no coordinates, rotation, transform, or
// other world-position field is exposed anywhere in the protocol
// (exhaustively verified against source and live captures).
function resolveComeDestination(senderData) {
    const senderFurniId = senderData.seat_furni_id;
    const senderSeatNumber = senderData.seat_number;

    const furniIdStr = senderFurniId === undefined || senderFurniId === null
        ? ''
        : String(senderFurniId);
    const seatNumberNum = Number(senderSeatNumber);

    if (!furniIdStr || furniIdStr === '0' || !Number.isFinite(seatNumberNum)) {
        return { ok: false, reason: 'no_seat', senderFurniId, senderSeatNumber };
    }

    return { ok: true, furniId: furniIdStr, seatNumber: seatNumberNum };
}

// Binds the shared logic to one bot's own client/cid/room/sendReply.
// comeInProgress/lastComeAt live inside this closure, so Bot A and Bot B
// (separate processes, separate calls to this factory) each get their own
// independent cooldown/in-progress state, exactly as before.
function createComeHandler({ client, cid, roomId, sendReply, logPrefix = '[Come]' }) {
    let comeInProgress = false;
    let lastComeAt = 0;

    async function runCome(msg) {
        const senderCid = msg && msg.user_id !== undefined && msg.user_id !== null
            ? String(msg.user_id)
            : '';

        if (!IMVU_COME_ENABLED) {
            console.log(`⏸ ${logPrefix} !come received but IMVU_COME_ENABLED is not "true" — ignoring.`);
            return;
        }

        if (!/^\d+$/.test(senderCid)) {
            console.log(`❌ ${logPrefix} Malformed sender id, ignoring: ${JSON.stringify(msg && msg.user_id)}`);
            return;
        }

        if (!IMVU_COME_ALLOWED_USERIDS.has(senderCid)) {
            console.log(`⛔ ${logPrefix} Unauthorized !come from ${senderCid} — not in IMVU_COME_ALLOWED_USERIDS.`);
            sendReply(UNAUTHORIZED_MESSAGE);
            return;
        }

        if (comeInProgress) {
            console.log(`⏳ ${logPrefix} Ignoring !come from ${senderCid} — another !come is already in progress.`);
            return;
        }

        const sinceLastCome = Date.now() - lastComeAt;
        if (sinceLastCome < COME_COOLDOWN_MS) {
            const waitSec = Math.ceil((COME_COOLDOWN_MS - sinceLastCome) / 1000);
            sendReply(`⏳ !come is on cooldown — try again in ${waitSec}s.`);
            return;
        }

        comeInProgress = true;
        lastComeAt = Date.now();

        try {
            // 1. Read the sender's own current seat (GET only).
            const senderPath = `/chat/chat-${roomId}/participants/user-${senderCid}`;
            let senderRes;
            try {
                senderRes = await client.request(senderPath);
            } catch (err) {
                console.error(`❌ ${logPrefix} Failed to read sender ${senderCid}'s participant resource: ${err.message}`);
                sendReply('❌ Could not read your current seat — are you still in the room?');
                return;
            }

            const senderEntry = senderRes && senderRes.denormalized && senderRes.id
                ? senderRes.denormalized[senderRes.id]
                : null;
            const senderData = senderEntry && senderEntry.data;

            if (!senderData) {
                console.error(`❌ ${logPrefix} Sender ${senderCid} participant resource had no usable data.`);
                sendReply('❌ Could not read your current seat.');
                return;
            }

            // 2. Resolve a destination from the sender's captured data (see
            //    resolveComeDestination() above for why this is isolated).
            const destination = resolveComeDestination(senderData);

            if (!destination.ok) {
                console.log(`ℹ️ ${logPrefix} Sender ${senderCid} has no valid seat (seat_furni_id=${JSON.stringify(destination.senderFurniId)}, seat_number=${JSON.stringify(destination.senderSeatNumber)}).`);
                sendReply('🪑 You need to be sitting on a room seat first — !come only follows a real seat, not open floor.');
                return;
            }

            const { furniId: furniIdStr, seatNumber: seatNumberNum } = destination;

            // 3. Reproduce that exact seat on the bot's own participant
            //    resource. Field types match the verified live capture
            //    exactly: seat_furni_id as a string, seat_number as a number.
            const botPath = `/chat/chat-${roomId}/participants/user-${cid}`;
            const payload = { seat_furni_id: furniIdStr, seat_number: seatNumberNum };

            let moveRes;
            try {
                moveRes = await client.request(botPath, { method: 'POST', data: payload });
            } catch (err) {
                console.error(`❌ ${logPrefix} Seat POST failed: ${err.message}`);
                sendReply('❌ Move failed — could not update seat.');
                return;
            }

            const movedEntry = moveRes && moveRes.denormalized && moveRes.id
                ? moveRes.denormalized[moveRes.id]
                : null;
            const movedData = movedEntry && movedEntry.data;

            const returnedFurniId = movedData && movedData.seat_furni_id !== undefined
                ? String(movedData.seat_furni_id)
                : null;
            const returnedSeatNumber = movedData ? Number(movedData.seat_number) : NaN;

            const matched = returnedFurniId === furniIdStr && returnedSeatNumber === seatNumberNum;

            console.log(`${matched ? '✅' : '⚠️'} ${logPrefix} sender=${senderCid} requested seat_furni_id=${furniIdStr} seat_number=${seatNumberNum} -> server returned seat_furni_id=${returnedFurniId} seat_number=${returnedSeatNumber}`);

            sendReply(matched
                ? '✅ Coming!'
                : '⚠️ Move request sent, but the server assigned a different seat than requested — that spot may already be taken.');
        } finally {
            comeInProgress = false;
        }
    }

    return { runCome };
}

module.exports = {
    createComeHandler,
    resolveComeDestination,
    IMVU_COME_ENABLED,
    IMVU_COME_ALLOWED_USERIDS,
    COME_COOLDOWN_MS,
    UNAUTHORIZED_MESSAGE,
};
