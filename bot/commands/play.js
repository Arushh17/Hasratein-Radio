const fs = require("fs");
const path = require("path");
const youtube = require("../../services/youtube");

module.exports = async function(song) {
    try {
        const video = await youtube.search(song);

        console.log("✅ Song Found");
        console.log("🎵 " + video.title);

        const currentSong = {
            videoId: video.videoId,
            title: video.title,
            filename: ""
        };

        const jsonPath = path.join(
            __dirname,
            "../../database/currentSong.json"
        );

        fs.writeFileSync(
            jsonPath,
            JSON.stringify(currentSong, null, 4)
        );

        console.log("▶️ YouTube song selected.");
        console.log("🎵 Current song: " + video.title);
        console.log("🆔 Video ID: " + video.videoId);

        // Tell the running server that the song changed
        const http = require("http");

        const data = JSON.stringify(currentSong);

        const request = http.request(
            {
                hostname: "localhost",
                port: 3000,
                path: "/songChanged",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data)
                }
            },
            (response) => {
                console.log(
                    "📡 Song change notification sent:",
                    response.statusCode
                );
            }
        );

        request.on("error", (error) => {
            console.log(
                "⚠️ Could not notify server:",
                error.message
            );
        });

        request.write(data);
        request.end();

    } catch (err) {
        console.log("❌ Play error:", err);
    }
};