/* Rise Upon Deen V2 — one coordinated PWA + FCM service worker. */
const RUD_V2_SHELL_CACHE = 'rud-v2-shell-v6';
const RUD_V2_AUDIO_CACHE = 'rud-v2-audio-v1';
const RUD_V2_AUDIO_LIMIT = 120;
const RUD_V2_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];
const RUD_PUSH_DB = 'rud-notifications-v2';
const RUD_PUSH_STORE = 'settings';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(RUD_V2_SHELL_CACHE);
    await Promise.allSettled(RUD_V2_SHELL_ASSETS.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key !== RUD_V2_SHELL_CACHE && (key.startsWith('rud-shell-') || key.startsWith('rud-v2-shell-')))
        .map(key => caches.delete(key))
    );
    /* Important: do not delete Rise Upon Deen content/IndexedDB caches here. */
    await self.clients.claim();
  })());
});

/* Keep the existing navigation strategy lightweight: network first, cached app shell offline. */
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  /* Cache recitation files after first successful playback so previously
     played Ayahs can continue to work offline. We never pre-download audio. */
  if (request.destination === 'audio') {
    event.respondWith((async () => {
      const cache = await caches.open(RUD_V2_AUDIO_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) {
          await cache.put(request, response.clone()).catch(() => {});
          const keys = await cache.keys();
          if (keys.length > RUD_V2_AUDIO_LIMIT) {
            await Promise.all(keys.slice(0, keys.length - RUD_V2_AUDIO_LIMIT).map(key => cache.delete(key)));
          }
        }
        return response;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }

  if (request.mode !== 'navigate') return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(RUD_V2_SHELL_CACHE);
        cache.put(request, response.clone()).catch(() => {});
        if (new URL(request.url).pathname === '/') {
          cache.put('/index.html', response.clone()).catch(() => {});
        }
      }
      return response;
    } catch {
      return (await caches.match(request)) ||
             (await caches.match('/index.html')) ||
             (await caches.match('/')) ||
             new Response('Rise Upon Deen is offline. Reconnect once to refresh the app shell.', {
               status: 503,
               headers: {'Content-Type': 'text/plain; charset=utf-8'}
             });
    }
  })());
});

function rudOpenPushDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return resolve(null);
    const req = indexedDB.open(RUD_PUSH_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUD_PUSH_STORE)) db.createObjectStore(RUD_PUSH_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rudIdbGet(key) {
  const db = await rudOpenPushDb();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RUD_PUSH_STORE, 'readonly');
      const req = tx.objectStore(RUD_PUSH_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function rudIdbPut(key, value) {
  const db = await rudOpenPushDb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RUD_PUSH_STORE, 'readwrite');
      tx.objectStore(RUD_PUSH_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function rudPushAllowed(data) {
  const prefs = await rudIdbGet('preferences');
  if (!prefs || prefs.enabled !== true) return false;
  const category = String(data?.category || 'announcement');
  if (prefs.categories && Object.prototype.hasOwnProperty.call(prefs.categories, category) && prefs.categories[category] === false) return false;

  const dedupeId = String(data?.dedupeId || '').trim();
  if (!dedupeId) return true;
  const state = (await rudIdbGet('last-delivery')) || {};
  const now = Date.now();
  if (state.id === dedupeId && now - Number(state.at || 0) < 7 * 24 * 60 * 60 * 1000) return false;
  await rudIdbPut('last-delivery', {id: dedupeId, at: now});
  return true;
}

function rudSafeRoute(route) {
  const value = String(route || '#home').trim();
  if (!value.startsWith('#')) return '#home';
  return value;
}

/* Register the click handler before Firebase Messaging so Rise Upon Deen owns routing. */
self.addEventListener('notificationclick', event => {
  event.stopImmediatePropagation();
  event.notification?.close();
  const route = rudSafeRoute(event.notification?.data?.route);
  const target = new URL('/', self.location.origin);
  target.hash = route.slice(1);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      try {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('navigate' in client) await client.navigate(target.href);
        return await client.focus();
      } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(target.href);
  })());
});

/*
  Firebase Cloud Messaging is free to use. These are public client SDK files,
  not private credentials. FCM uses the public VAPID key supplied by the page.
*/
try {
  importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey: 'AIzaSyBZPyFOJzSz3av4LgzaysGoebANTE7AgW0',
    authDomain: 'riseupondeen.firebaseapp.com',
    projectId: 'riseupondeen',
    storageBucket: 'riseupondeen.firebasestorage.app',
    messagingSenderId: '1040242494871',
    appId: '1:1040242494871:web:ab5b758e64a4e430b288d2',
    measurementId: 'G-E3W4MGY8G7'
  });

  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(async payload => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    if (!(await rudPushAllowed(data))) return;

    const title = String(data.title || 'Rise Upon Deen').slice(0, 120);
    const body = String(data.message || data.body || 'A gentle reminder from Rise Upon Deen.').slice(0, 280);
    const route = rudSafeRoute(data.route);
    const category = String(data.category || 'announcement');
    const dedupeId = String(data.dedupeId || `${category}:${title}:${body}`).slice(0, 120);

    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `rud-${dedupeId}`,
      renotify: false,
      requireInteraction: false,
      silent: false,
      data: {route, category, dedupeId}
    });
  });
} catch (error) {
  /* The PWA/cache must continue working even if the messaging CDN is unreachable. */
  console.warn('Rise Upon Deen FCM service worker initialization unavailable:', error);
}
