const socket = io();

const player = document.getElementById("player");
const songName = document.getElementById("songName");
const timeDisplay = document.getElementById("timeDisplay");

let songDuration = 0;

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }

    seconds = Math.floor(seconds);

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    return minutes + ":" + String(secs).padStart(2, "0");
}

function updateTimeDisplay() {
    const current = player.currentTime || 0;

    timeDisplay.textContent =
        formatTime(current) +
        " / " +
        formatTime(songDuration);
}

async function updateSong(autoPlay = false) {
    try {
        const response = await fetch("/database/currentSong.json");
        const data = await response.json();

        if (!data.videoId) {
            console.log("❌ No YouTube video currently selected");
            return;
        }

        player.src = "/stream";
        songName.textContent = "🎵 " + data.title;

        // Get duration from YouTube metadata
        try {
            const metadataResponse = await fetch(
                "/search?q=" +
                encodeURIComponent(data.title)
            );

            const metadata = await metadataResponse.json();

            if (
                metadata.success &&
                metadata.video &&
                metadata.video.duration
            ) {
                const parts = metadata.video.duration.split(":");

                if (parts.length === 2) {
                    songDuration =
                        parseInt(parts[0], 10) * 60 +
                        parseInt(parts[1], 10);
                } else if (parts.length === 3) {
                    songDuration =
                        parseInt(parts[0], 10) * 3600 +
                        parseInt(parts[1], 10) * 60 +
                        parseInt(parts[2], 10);
                }
            }
        } catch (error) {
            console.log("⚠️ Duration lookup failed");
        }

        player.load();
        updateTimeDisplay();

        if (autoPlay) {
            await player.play();
            console.log("▶️ Playing:", data.title);
        }

    } catch (error) {
        console.error("❌ Song load error:", error);
    }
}

player.addEventListener(
    "timeupdate",
    updateTimeDisplay
);

player.addEventListener(
    "play",
    updateTimeDisplay
);

player.addEventListener(
    "pause",
    updateTimeDisplay
);

player.addEventListener(
    "ended",
    () => {
        console.log(
            "⏭️ Song ended — requesting next song"
        );

        socket.emit("nextSong");
    }
);

updateSong(false);

socket.on(
    "songChanged",
    () => {
        updateSong(true);
    }
);
