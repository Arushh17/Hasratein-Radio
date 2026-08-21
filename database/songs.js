const db = require("./db");

function addSong(filename, title, artist, duration, source) {
    db.run(
        `INSERT OR IGNORE INTO songs
        (filename, title, artist, duration, source)
        VALUES (?, ?, ?, ?, ?)`,
        [filename, title, artist, duration, source]
    );
}

function getAllSongs(callback) {
    db.all(
        "SELECT * FROM songs ORDER BY title",
        [],
        (err, rows) => callback(err, rows)
    );
}

function searchSong(keyword, callback) {
    db.all(
        `SELECT * FROM songs
        WHERE title LIKE ?
        OR artist LIKE ?
        OR filename LIKE ?`,
        [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`],
        (err, rows) => callback(err, rows)
    );
}

function deleteSong(filename) {
    db.run(
        "DELETE FROM songs WHERE filename=?",
        [filename]
    );
}

module.exports = {
    addSong,
    getAllSongs,
    searchSong,
    deleteSong
};
