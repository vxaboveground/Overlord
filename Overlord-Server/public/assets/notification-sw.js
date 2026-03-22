self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : "/notifications";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          try {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin === self.location.origin) {
              if (clientUrl.pathname !== "/notifications") {
                client.navigate(targetUrl);
              }
              return client.focus();
            }
          } catch {}
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "show_notification") return;

  const title = String(data.title || "Overlord Notification");
  const options = {
    body: String(data.body || ""),
    icon: data.icon || "/assets/overlord.png",
    badge: "/assets/overlord.png",
    tag: data.tag || `overlord-${Date.now()}`,
    data: { url: "/notifications" },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});
