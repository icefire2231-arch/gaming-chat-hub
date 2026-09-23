/*
 * NexusChat — Service Worker
 * Rôles :
 *   1) PWA : mise en cache des ressources STATIQUES uniquement (app shell), jamais
 *      Firestore/Auth ni de données personnelles.
 *   2) Notifications push en arrière-plan via Firebase Cloud Messaging (FCM).
 *   3) Clic sur une notification -> ouvre/refocalise NexusChat sur le bon salon/MP.
 *
 * Réutilise le même projet Firebase que le site (gaming-chat-hub) : aucune
 * nouvelle configuration Firebase n'est créée.
 */

const CACHE_NAME = 'nexuschat-shell-v1';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Stratégie réseau-d'abord pour le HTML (toujours la dernière version du chat),
// cache-d'abord pour les ressources statiques du shell. On ne touche JAMAIS aux
// requêtes Firestore/Firebase Auth/Storage (elles passent sans interception).
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const isFirebaseApi = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit|securetoken\.googleapis\.com|firebasestorage\.googleapis\.com/.test(url.hostname);
    if (isFirebaseApi) return; // ne jamais mettre en cache des données privées

    const isNavigation = req.mode === 'navigate';
    if (isNavigation) {
        event.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
        );
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then((cached) => cached || fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
                return res;
            }).catch(() => cached))
        );
    }
});

/* ============================================================
   Firebase Cloud Messaging — notifications reçues quand l'onglet
   n'est pas au premier plan (ou fermé, si le navigateur le permet).
   Les scripts "compat" sont utilisés ici car les service workers ne
   supportent pas encore les imports ES module partout (Firefox, Safari).
   ============================================================ */
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Même config que le site principal (gaming-chat-hub) — ce ne sont pas des secrets,
// la sécurité réelle est assurée par les règles Firestore/Auth, pas par ces clés.
firebase.initializeApp({
    apiKey: "AIzaSyB9P5Y1ywmsbQt_PMCNsiRkryppVI1421o",
    authDomain: "gaming-chat-hub.firebaseapp.com",
    projectId: "gaming-chat-hub",
    storageBucket: "gaming-chat-hub.firebasestorage.app",
    messagingSenderId: "838358986335",
    appId: "1:838358986335:web:1294305385b47d9bb275ea"
});

let messaging = null;
try { messaging = firebase.messaging(); } catch (e) { /* FCM indisponible sur ce navigateur (ex: Safari sans config APNs) */ }

// Message "data-only" envoyé par la Cloud Function (voir functions/index.js) :
// on construit nous-mêmes la notification pour garder le contrôle total du rendu et du clic.
if (messaging) {
    messaging.onBackgroundMessage((payload) => {
        const data = payload.data || {};
        const title = data.title || 'NexusChat';
        const body = data.body || '';
        const tag = data.tag || `${data.convType || ''}_${data.convId || ''}`;
        self.registration.showNotification(title, {
            body,
            tag,                       // regroupe les notifications d'une même conversation
            renotify: true,
            icon: 'icons/icon-192.png',
            badge: 'icons/icon-192.png',
            data: { convType: data.convType, convId: data.convId, convName: data.convName || '' }
        });
    });
}

// Clic sur la notification : ouvre NexusChat (ou refocalise l'onglet existant)
// et navigue directement vers le bon salon/MP/groupe via les paramètres d'URL.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const d = event.notification.data || {};
    const params = new URLSearchParams();
    if (d.convType) params.set('open', d.convType);
    if (d.convId) params.set('id', d.convId);
    if (d.convName) params.set('name', d.convName);
    const targetUrl = params.toString() ? `./?${params.toString()}` : './';

    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
            // Un onglet NexusChat est déjà ouvert : on le refocalise et on lui envoie la destination
            if ('focus' in client) {
                client.postMessage({ type: 'notification-click', convType: d.convType, convId: d.convId, convName: d.convName });
                return client.focus();
            }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })());
});
