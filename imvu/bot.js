const IMVU = require("imvu.js");

console.log("Hasratein Radio IMVU Bot starting...");

const imvu = new IMVU({
  show_online: true
});

imvu.on("ready", () => {
  console.log("IMVU bot connected!");
  console.log("Bot: " + imvu.display_name);
});

imvu.on("message", async (message) => {
  if (message.user && message.user.bot) return;

  const text = message.content ? message.content.trim() : "";

  console.log("Message: " + text);

  if (text === "!test") {
    await imvu.say("Hasratein Radio Bot is online!");
  }
});

imvu.on("join", async (user) => {
  if (user.bot) return;

  await imvu.say("Welcome " + user.display_name + " to Hasratein Radio!");
});

imvu.login("YOUR_ACTUAL_TOKEN");