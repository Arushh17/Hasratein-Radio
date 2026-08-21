console.log("🤖 Hasratein Bot Started");

const play = require("./commands/play");

async function handleCommand(command) {
    console.log("Command:", command);

    if (command.startsWith("!play ")) {
        const song = command.replace("!play ", "").trim();

        if (!song) {
            console.log("❌ Song name missing");
            return;
        }

        await play(song);

        console.log("📡 Sent:", song);
    }
}

process.stdin.setEncoding("utf8");

process.stdin.on("data", (input) => {
    handleCommand(input.trim());
});