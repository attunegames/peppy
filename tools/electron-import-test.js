// Every module the app loads must load in ELECTRON, not just in Node.
//
// Electron ships an older Node than the one the tests run on, and the two
// disagree about how much of a CommonJS module an ESM `import` can name. That
// difference has bitten this project twice: supabase needing a WebSocket the
// app's Node did not have, and slippi-js named imports that work in the tests
// and throw in the app. Both times the failure was silent - the module simply
// never loaded, and everything that needed it quietly did nothing.
//
// Run with: npx electron tools/electron-import-test.js
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app } = require("electron");

const MODULES = ["dolphin.mjs", "peppynet.mjs", "replays.mjs", "spectate.mjs"];

app.whenReady().then(async () => {
  let bad = 0;
  console.log(`electron ${process.versions.electron}, node ${process.versions.node}`);
  for (const name of MODULES) {
    const url = pathToFileURL(path.join(__dirname, "..", "orchestrator", name)).href;
    try {
      await import(url);
      console.log("PASS  " + name + " loads in the app");
    } catch (err) {
      bad++;
      console.log("FAIL  " + name + " -> " + String(err.message).split("\n")[0]);
    }
  }
  console.log(bad ? `\n${bad} module(s) the app cannot load` : "\nevery module loads in the app");
  app.exit(bad ? 1 : 0);
});
