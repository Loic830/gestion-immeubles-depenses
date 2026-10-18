// Service worker d'Immeubles So-Max (v0.8.9) : notifications poussées seulement.
// Pas de cache ni de mode hors ligne.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Notification reçue du serveur : { titre, description, id }
self.addEventListener("push", (e) => {
  let donnees = {};
  try { donnees = e.data ? e.data.json() : {}; } catch { donnees = { description: e.data ? e.data.text() : "" }; }
  const titre = donnees.titre || "Immeubles So-Max";
  e.waitUntil((async () => {
    await self.registration.showNotification(titre, {
      body: donnees.description || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: donnees.id || undefined,
      data: { url: "/" },
    });
    // App ouverte : la cloche se met à jour tout de suite
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    fenetres.forEach((c) => c.postMessage({ type: "notification-recue" }));
  })());
});

// Toucher la notification : ouvrir l'app à l'accueil. Elle reste non lue dans le centre.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL("/", self.location.origin).href;
  e.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of fenetres) {
      if (c.url.startsWith(self.location.origin)) {
        await c.focus();
        if ("navigate" in c) await c.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
