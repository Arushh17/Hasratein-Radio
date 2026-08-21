const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(
    path.join(__dirname, "radio.db"),
    (err) => {
        if (err) {
            console.error("❌ Database Error:", err.message);
        } else {
            console.log("✅ Connected to SQLite Database");
        }
    }
);

module.exports = db;