// The browser capture extension's ID. Not a secret, and not configuration: Chrome
// derives it from the public `key` in extension/manifest.json, so it is identical
// on every machine and every reinstall. Change the two together or not at all —
// a mismatch fails silently (the connect page's message never arrives and CORS
// rejects every capture). See docs/chrome-extension-capture-design.md, Pitfall 12.
export const EXTENSION_ID = "kfchhokbhfkeimjnaifkhdahndkmfgjm";

export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
