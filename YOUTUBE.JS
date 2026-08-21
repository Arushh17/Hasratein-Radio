const { execFile } = require("child_process");

function getAudioUrl(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/local/bin/yt-dlp",
      ["-f", "bestaudio", "-g", url],
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

module.exports = { getAudioUrl };
