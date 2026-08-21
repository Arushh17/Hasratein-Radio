const db = require("./db");

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE,
            title TEXT,
            artist TEXT,
            duration INTEGER,
            source TEXT
        )
    `);

    console.log("✅ Songs table is ready.");
});

db.close();
