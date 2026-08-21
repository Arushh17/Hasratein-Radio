const express = require("express");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const { Server } = require("socket.io");

const youtubeController = require("./controllers/youtubeController");

require("./bot/bot");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const ytDlpPath = "/usr/local/bin/yt-dlp";
const ffmpegPath = "/usr/local/bin/ffmpeg";

app.use(express.static(path.join(__dirname, "public")));

app.use(
    "/music",
    express.static(path.join(__dirname, "music"))
);

app.use(
    "/database",
    express.static(path.join(__dirname, "database"))
);

app.get("/search", youtubeController.searchSong);

app.use(express.json());

app.post("/songChanged", (req, res) => {

    console.log(
        "📡 Bot song change received:",
        req.body.title
    );

    io.emit(
        "songChanged",
        req.body
    );

    res.json({
        success: true
    });

});


// ================================
// AUDIO STREAM
// YouTube → yt-dlp → FFmpeg → MP3
// ================================

app.get("/stream", async (req, res) => {

    let ytProcess = null;
    let ffmpegProcess = null;

    let clientClosed = false;
    let streamStarted = false;

    try {

        const currentSongPath = path.join(
            __dirname,
            "database",
            "currentSong.json"
        );

        if (!fs.existsSync(currentSongPath)) {

            return res.status(404).send(
                "currentSong.json not found"
            );

        }

        const currentSong = JSON.parse(
            fs.readFileSync(
                currentSongPath,
                "utf8"
            )
        );

        if (!currentSong.videoId) {

            return res.status(404).send(
                "No song is currently playing"
            );

        }

        const videoId =
            currentSong.videoId;

        console.log(
            "🎧 Stream request for:",
            videoId
        );

        const youtubeUrl =
            "https://www.youtube.com/watch?v=" +
            videoId;


        // ================================
        // START YT-DLP
        // ================================

        const ytArgs = [

            "--no-playlist",

            "--js-runtimes",
            "node",

            "--remote-components",
            "ejs:github",

            "--cookies-from-browser",
            "chrome",

            "-f",
            "18",

            "-o",
            "-",

            youtubeUrl

        ];

        console.log(
            "▶️ Starting yt-dlp..."
        );

        ytProcess = spawn(
            ytDlpPath,
            ytArgs,
            {
                stdio: [
                    "ignore",
                    "pipe",
                    "pipe"
                ]
            }
        );


        ytProcess.on(
            "error",
            (error) => {

                console.error(
                    "❌ yt-dlp error:",
                    error
                );

                if (
                    !res.headersSent &&
                    !clientClosed
                ) {

                    res.status(500).send(
                        "Unable to start yt-dlp"
                    );

                }

            }
        );


        ytProcess.stderr.on(
            "data",
            (data) => {

                const message =
                    data
                        .toString()
                        .trim();

                if (message) {

                    console.log(
                        "yt-dlp:",
                        message
                    );

                }

            }
        );


        // ================================
        // START FFMPEG
        // ================================

        const ffmpegArgs = [

            "-i",
            "pipe:0",

            "-vn",

            "-acodec",
            "libmp3lame",

            "-ar",
            "44100",

            "-ac",
            "2",

            "-b:a",
            "192k",

            "-f",
            "mp3",

            "pipe:1"

        ];

        console.log(
            "🎛️ Starting FFmpeg..."
        );

        ffmpegProcess = spawn(
            ffmpegPath,
            ffmpegArgs,
            {
                stdio: [
                    "pipe",
                    "pipe",
                    "pipe"
                ]
            }
        );


        // ================================
        // IMPORTANT:
        // PREVENT EPIPE CRASH
        // ================================

        ffmpegProcess.stdin.on(
            "error",
            (error) => {

                if (error.code === "EPIPE") {

                    console.log(
                        "ℹ️ FFmpeg input closed."
                    );

                    return;

                }

                console.error(
                    "❌ FFmpeg stdin error:",
                    error
                );

            }
        );


        ffmpegProcess.on(
            "error",
            (error) => {

                console.error(
                    "❌ FFmpeg error:",
                    error
                );

                if (
                    !res.headersSent &&
                    !clientClosed
                ) {

                    res.status(500).send(
                        "Unable to start FFmpeg"
                    );

                }

            }
        );


        ffmpegProcess.stderr.on(
            "data",
            (data) => {

                const message =
                    data
                        .toString()
                        .trim();

                if (message) {

                    console.log(
                        "FFmpeg:",
                        message
                    );

                }

            }
        );


        // ================================
        // YT-DLP → FFMPEG
        // ================================

        let totalBytes = 0;

        ytProcess.stdout.on(
            "data",
            (chunk) => {

                if (clientClosed) {
                    return;
                }

                if (
                    !ffmpegProcess ||
                    ffmpegProcess.killed ||
                    ffmpegProcess.stdin.destroyed
                ) {

                    return;

                }

                totalBytes +=
                    chunk.length;

                console.log(
                    "🎵 yt-dlp DATA:",
                    chunk.length,
                    "bytes | TOTAL:",
                    totalBytes
                );

                try {

                    const canContinue =
                        ffmpegProcess.stdin.write(
                            chunk
                        );

                    if (!canContinue) {

                        ytProcess.stdout.pause();

                        ffmpegProcess.stdin.once(
                            "drain",
                            () => {

                                if (
                                    !clientClosed &&
                                    ytProcess &&
                                    !ytProcess.killed
                                ) {

                                    ytProcess.stdout.resume();

                                }

                            }
                        );

                    }

                } catch (error) {

                    if (
                        error.code === "EPIPE"
                    ) {

                        console.log(
                            "ℹ️ FFmpeg pipe closed."
                        );

                    } else {

                        console.error(
                            "❌ Pipe error:",
                            error
                        );

                    }

                }

            }
        );


        ytProcess.stdout.on(
            "end",
            () => {

                console.log(
                    "🎵 yt-dlp output finished. TOTAL:",
                    totalBytes,
                    "bytes"
                );

                if (
                    ffmpegProcess &&
                    !ffmpegProcess.killed &&
                    !ffmpegProcess.stdin.destroyed
                ) {

                    try {

                        ffmpegProcess.stdin.end();

                    } catch (error) {

                        if (
                            error.code !==
                            "EPIPE"
                        ) {

                            console.error(
                                "❌ Pipe end error:",
                                error
                            );

                        }

                    }

                }

            }
        );


        // ================================
        // FFMPEG → BROWSER
        // ================================

        ffmpegProcess.stdout.on(
            "data",
            (chunk) => {

                if (clientClosed) {
                    return;
                }

                if (!res.headersSent) {

                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "audio/mpeg",

                            "Cache-Control":
                                "no-cache",

                            "Connection":
                                "keep-alive",

                            "Transfer-Encoding":
                                "chunked"
                        }
                    );

                    streamStarted =
                        true;

                    console.log(
                        "📡 AUDIO STREAM STARTED"
                    );

                }

                if (
                    !res.writableEnded &&
                    !res.destroyed
                ) {

                    res.write(chunk);

                }

            }
        );


        // ================================
        // FFMPEG CLOSED
        // ================================

        ffmpegProcess.on(
            "close",
            (code, signal) => {

                console.log(
                    "🎛️ FFmpeg closed:",
                    code,
                    signal || ""
                );

                if (
                    !res.writableEnded &&
                    !res.destroyed
                ) {

                    res.end();

                }

            }
        );


        // ================================
        // YT-DLP CLOSED
        // ================================

        ytProcess.on(
            "close",
            (code, signal) => {

                console.log(
                    "▶️ yt-dlp closed:",
                    code,
                    signal || ""
                );

                if (
                    ffmpegProcess &&
                    !ffmpegProcess.killed &&
                    !ffmpegProcess.stdin.destroyed
                ) {

                    try {

                        ffmpegProcess.stdin.end();

                    } catch (error) {

                        if (
                            error.code !==
                            "EPIPE"
                        ) {

                            console.error(
                                "❌ Pipe close error:",
                                error
                            );

                        }

                    }

                }

            }
        );


        // ================================
        // CLIENT DISCONNECTED
        // ================================

        req.on(
            "close",
            () => {

                if (clientClosed) {
                    return;
                }

                clientClosed = true;

                console.log(
                    "🛑 Stream client disconnected"
                );


                if (
                    ytProcess &&
                    !ytProcess.killed
                ) {

                    ytProcess.kill(
                        "SIGTERM"
                    );

                }


                if (
                    ffmpegProcess &&
                    !ffmpegProcess.killed
                ) {

                    ffmpegProcess.kill(
                        "SIGTERM"
                    );

                }

            }
        );


    } catch (error) {

        console.error(
            "❌ Stream error:",
            error
        );

        if (
            !res.headersSent &&
            !res.destroyed
        ) {

            res.status(500).send(
                "Unable to stream audio"
            );

        }

    }

});


// ================================
// SOCKET.IO
// ================================

io.on(
    "connection",
    (socket) => {

        console.log(
            "Client Connected"
        );


        socket.on(
            "songChanged",
            (song) => {

                console.log(
                    "📡 Broadcasting:",
                    song
                );

                io.emit(
                    "songChanged",
                    song
                );

            }
        );


        socket.on(
            "nextSong",
            () => {

                const musicDir =
                    path.join(
                        __dirname,
                        "music"
                    );


                if (!fs.existsSync(musicDir)) {

                    console.log(
                        "❌ Music folder not found"
                    );

                    return;

                }


                const files =
                    fs.readdirSync(
                        musicDir
                    )
                    .filter(
                        file =>
                            file.endsWith(".mp4")
                    );


                if (
                    files.length === 0
                ) {

                    console.log(
                        "❌ No songs available"
                    );

                    return;

                }


                const currentSongPath =
                    path.join(
                        __dirname,
                        "database",
                        "currentSong.json"
                    );


                let currentSong = {};


                if (
                    fs.existsSync(
                        currentSongPath
                    )
                ) {

                    currentSong =
                        JSON.parse(
                            fs.readFileSync(
                                currentSongPath,
                                "utf8"
                            )
                        );

                }


                let index =
                    files.indexOf(
                        currentSong.filename
                    );


                index =
                    index + 1;


                if (
                    index >= files.length
                ) {

                    index = 0;

                }


                const filename =
                    files[index];


                const title =
                    filename
                        .replace(
                            /\s*\[[^\]]+\]\.mp4$/,
                            ""
                        )
                        .trim();


                const videoIdMatch =
                    filename.match(
                        /\[([^\]]+)\]\.mp4$/
                    );


                const videoId =
                    videoIdMatch
                        ? videoIdMatch[1]
                        : "";


                const nextSong = {

                    videoId:
                        videoId,

                    filename:
                        filename,

                    title:
                        title

                };


                fs.writeFileSync(
                    currentSongPath,
                    JSON.stringify(
                        nextSong,
                        null,
                        4
                    )
                );


                console.log(
                    "⏭️ Next song:",
                    title
                );


                console.log(
                    "🎬 Video ID:",
                    videoId
                );


                io.emit(
                    "songChanged",
                    nextSong
                );

            }
        );


        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Client Disconnected"
                );

            }
        );

    }
);


// ================================
// START SERVER
// ================================

server.listen(
    PORT,
    () => {

        console.log(
            "Hasratein Radio Server running at http://localhost:" +
            PORT
        );

    }
);