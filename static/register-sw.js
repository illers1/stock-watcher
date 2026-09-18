// Registers the service worker that makes the installed app open without a
// connection. Loaded by every page; harmless where service workers are not
// available, such as a file:// open or plain http on a phone.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
