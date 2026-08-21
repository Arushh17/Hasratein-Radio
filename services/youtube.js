const ytSearch = require("yt-search");
const path = require("path");
const { spawn } = require("child_process");

class YouTubeService {

    async search(query) {
        const result = await ytSearch(query);

        if (!result.videos.length) {
            throw new Error("No videos found");
        }

        return result.videos[0];
    }

    async getMetadata(videoId) {
        const video = await this.search(videoId);

        return {
            id: video.videoId,
            title: video.title,
            author: video.author.name,
            duration: video.timestamp,
            thumbnail: video.thumbnail,
            url: video.url
        };
    }

    getStream(videoId) {
        console.log("🎵 Getting YouTube audio stream for:", videoId);

        const youtubeUrl =
            "https://www.youtube.com/watch?v=" + videoId;

        const ytDlpPath = path.join(process.env.HOME, "yt-dlp");

        const args = [
            "--js-runtimes",
            "deno",

            "--remote-components",
            "ejs:github",

            "--no-playlist",

            "-f",
            "251",

            

            "--user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36",

            "-g",

            youtubeUrl
        ];

        console.log("▶️ Starting yt-dlp...");

        return new Promise((resolve, reject) => {

            const ytProcess = spawn(ytDlpPath, args);

            let output = "";
            let errorOutput = "";

            ytProcess.stdout.on("data", (data) => {
                output += data.toString();
            });

            ytProcess.stderr.on("data", (data) => {
                errorOutput += data.toString();

                console.log(
                    "yt-dlp:",
                    data.toString().trim()
                );
            });

            ytProcess.on("error", (error) => {
                console.error(
                    "❌ yt-dlp process error:",
                    error
                );

                reject(error);
            });

            ytProcess.on("close", (code) => {

                console.log(
                    "yt-dlp process closed:",
                    code
                );

                if (code !== 0) {
                    return reject(
                        new Error(
                            "yt-dlp failed: " +
                            errorOutput
                        )
                    );
                }

                const streamUrl = output.trim();

                if (!streamUrl) {
                    return reject(
                        new Error(
                            "No YouTube stream URL returned"
                        )
                    );
                }

                console.log(
                    "✅ YouTube audio URL found"
                );

                resolve(streamUrl);
            });
        });
    }
}

module.exports = new YouTubeService();