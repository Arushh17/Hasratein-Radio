const youtube = require("../services/youtube");

async function searchSong(req, res) {
    try {
        const query = req.query.q;

        const video = await youtube.getMetadata((await youtube.search(query)).videoId);

        res.json({
            success: true,
            video
        });
    } catch (err) {
        res.status(500).json({
            error: err.message
        });
    }
}

module.exports = {
    searchSong
};