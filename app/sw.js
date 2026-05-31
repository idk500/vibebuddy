/**
 * Service Worker for VibeCoding Companion PWA
 *
 * Caches the app shell for offline use.
 * Network-first strategy for all requests.
 */

const CACHE_NAME = 'vibe-companion-v1'
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/main.css',
  '/js/app.js',
  '/js/ws.js',
  '/js/andon.js',
  '/js/log.js',
  '/js/util.js',
  '/manifest.json',
]

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  )
})

// Fetch: network-first, fallback to cache
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return

  // Skip WebSocket upgrades
  if (event.request.url.startsWith('ws://') || event.request.url.startsWith('wss://')) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses
        if (response.ok) {
          const cloned = response.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, cloned)
          })
        }
        return response
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
        })
      })
  )
})
