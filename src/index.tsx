import { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import type { ServerWebSocket } from "bun"

interface BlueskyPost {
  did: string
  time_us: number
  kind: string
  commit: {
    collection: string
    rkey: string
    cid: string
    record: {
      $type: string
      text: string
      createdAt: string
    }
  }
}

interface BlueskyProfile {
  did: string
  handle: string
  displayName: string
  avatar: string
}

interface CleanPost {
  id: string
  cid: string
  text: string
  createdAt: string
  url: string
  did: string
  author?: {
    did: string
    handle: string
    displayName: string
    avatar: string
  }
  meta: {
    queueSize: number
  }
}

const BLUESKY_FIREHOSE_URL = "wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post"
const BLUESKY_API_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile"

const profileCache = new Map<string, BlueskyProfile>()
const CACHE_DURATION = 1000 * 60 * 60 * 24 // 5 minutes

let connectedClients = 0;

function startConnectionLogger() {
  setInterval(() => {
    console.log(`Current connected clients: ${connectedClients}`);
  }, 60000 * 5); // Log every minute
}

startConnectionLogger();

class BlueskyConnection {
  private static instance: BlueskyConnection
  private ws: WebSocket | null = null
  private subscribers = new Set<(post: BlueskyPost) => void>()

  private constructor() {
    this.connect()
  }

  static getInstance(): BlueskyConnection {
    if (!BlueskyConnection.instance) {
      BlueskyConnection.instance = new BlueskyConnection()
    }
    return BlueskyConnection.instance
  }

  private connect() {
    if (this.ws) return

    this.ws = new WebSocket(BLUESKY_FIREHOSE_URL)

    this.ws.onmessage = async (event) => {
      try {
        const post = JSON.parse(event.data as string) as BlueskyPost
        this.subscribers.forEach((callback) => callback(post))
      } catch (error) {
        console.error("Error parsing post:", error)
      }
    }

    this.ws.onclose = () => {
      console.log("Bluesky connection closed, reconnecting...")
      this.ws = null
      setTimeout(() => this.connect(), 5000)
    }

    this.ws.onerror = (error) => {
      console.error("Bluesky WebSocket error:", error)
      this.ws?.close()
    }
  }

  subscribe(callback: (post: BlueskyPost) => void) {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }
}

async function getProfile(did: string): Promise<BlueskyProfile | null> {
  const cachedProfile = profileCache.get(did)
  if (cachedProfile) return cachedProfile

  try {
    const response = await fetch(`${BLUESKY_API_URL}?actor=${did}`)
    if (!response.ok) throw new Error(`Failed to fetch profile: ${response.statusText}`)

    const profile = (await response.json()) as BlueskyProfile

    profileCache.set(did, profile)

    setTimeout(() => {
      profileCache.delete(did)
    }, CACHE_DURATION)

    return profile
  } catch (error) {
    console.error(`Error fetching profile for ${did}:`, error)
    return null
  }
}

const app = new Hono()

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const searchTerm = c.req.query("search")?.toLowerCase() || ""
    const speed = parseInt(c.req.query("speed") || "1000")
    const fetchProfiles = c.req.query("fetchProfiles") === "true"

    let postQueue: CleanPost[] = []
    let intervalId: ReturnType<typeof setInterval>
    let unsubscribe: (() => void) | null = null

    return {
      onOpen: async (_evt, ws) => {
        connectedClients++;
        console.log("Client connected. Total clients:", connectedClients)

        unsubscribe = BlueskyConnection.getInstance().subscribe(async (post) => {
          if (post.commit?.record?.text) {
            if (!searchTerm || post.commit.record.text.toLowerCase().includes(searchTerm)) {
              let cleanPost: CleanPost = {
                id: post.commit.rkey,
                cid: post.commit.cid,
                text: post.commit.record.text,
                createdAt: post.commit.record.createdAt,
                url: `https://bsky.app/profile/${post.did}/post/${post.commit.rkey}`,
                did: post.did,
                meta: {
                  queueSize: postQueue.length,
                },
              }

              if (fetchProfiles) {
                const profile = await getProfile(post.did)
                if (profile) {
                  cleanPost.author = {
                    did: profile.did,
                    handle: profile.handle,
                    displayName: profile.displayName,
                    avatar: profile.avatar,
                  }
                }
              }

              postQueue.push(cleanPost)
            }
          }
        })

        intervalId = setInterval(() => {
          if (postQueue.length > 0) {
            const post = postQueue.shift()
            ws.send(JSON.stringify(post))
          }
        }, speed)
      },

      onMessage(_evt, ws) {
        console.log(`Received message from client: ${_evt.data}`)
      },

      onClose: () => {
        connectedClients--;
        console.log("Client disconnected. Total clients:", connectedClients)
        if (unsubscribe) {
          unsubscribe()
        }
        clearInterval(intervalId)
      },
    }
  })
)

app.get("/", (c) => {
  const searchTerm = c.req.query("search") || ""

  return c.html(
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Bluesky Wall</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-gray-100 min-h-screen">
        <button
          id="toggle-button"
          class="fixed top-4 right-4 z-50 bg-white rounded-full w-8 h-8 shadow flex items-center justify-center text-gray-400 hover:text-gray-600"
          onclick="toggleStyle()"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0-4 0"/><path d="M21 12q-3.6 6-9 6t-9-6q3.6-6 9-6t9 6"/></g></svg>
        </button>
        <footer class="fixed bottom-0 right-0 w-full text-sm p-4" id="credits">
          <p>
            Made by{" "}
            <a href="https://bsky.app/profile/matteogauthier.fr" class="text-blue-500 hover:underline" target="_blank">
              Mattèo Gauthier
            </a>
          </p>
          <a
            href="https://github.com/matteogauthier/bluesky-wall"
            class="text-xs text-gray-500 hover:underline"
            target="_blank"
          >
            View on GitHub
          </a>
        </footer>

        <div class="max-w-2xl mx-auto p-4">
          <div class="bg-white rounded-lg shadow p-4 mb-4 sticky top-4 main-container">
            <h1 class="text-2xl font-bold mb-2">Bluesky Wall</h1>
            <p class="text-gray-500 mb-4 text-sm">
              This website let you see the latest posts from a given search term on Bluesky. Make it perfect for
              conferences, events, live coding, etc.
            </p>

            <div class="space-y-4 actions">
              <div>
                <label htmlFor="search" class="block text-sm font-medium text-gray-700">
                  Search posts
                </label>
                <input
                  type="text"
                  name="search"
                  id="search"
                  value={searchTerm}
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2"
                  placeholder="Enter search term..."
                />
              </div>
              <div>
                <label htmlFor="speed" class="block text-sm font-medium text-gray-700">
                  Update speed (ms)
                </label>
                <input
                  type="range"
                  name="speed"
                  id="speed"
                  min="0"
                  max="5000"
                  step="100"
                  value="1000"
                  class="mt-1 block w-full"
                />
                <div class="text-sm text-gray-500 mt-1">
                  Current speed: <span id="speed-value">1000</span>ms
                </div>
              </div>
            </div>
          </div>

          <div id="posts" class="space-y-4"></div>
        </div>

        <template id="post-template">
          <div class="bg-white rounded-lg shadow p-4 hover:bg-gray-50 transition">
            <div class="flex space-x-3">
              <div class="flex-shrink-0">
                <img class="post-avatar h-10 w-10 rounded-full" src="" alt="" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center space-x-1">
                  <p class="post-author-name font-medium text-gray-900"></p>
                  <span class="text-gray-500">·</span>
                  <a href="" class="post-author-handle text-gray-500 hover:underline" target="_blank">
                    @<span class="handle"></span>
                  </a>
                </div>
                <p class="post-content text-gray-900 mt-1"></p>
                <div class="flex items-center space-x-2 mt-2">
                  <span class="post-time text-sm text-gray-500"></span>
                  <a href="" class="post-link text-sm text-blue-500 hover:underline" target="_blank">
                    View on Bluesky
                  </a>
                </div>
              </div>
            </div>
          </div>
        </template>

        <script
          dangerouslySetInnerHTML={{
            __html: `
              let ws;
              const posts = document.getElementById('posts');
              const postTemplate = document.getElementById('post-template');
              const searchInput = document.getElementById('search');
              const speedInput = document.getElementById('speed');
              const speedValue = document.getElementById('speed-value');
              const profileCache = new Map();

              async function fetchProfile(did) {
                if (profileCache.has(did)) {
                  return profileCache.get(did);
                }

                try {
                  const response = await fetch(\`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=\${did}\`);
                  if (!response.ok) throw new Error('Failed to fetch profile');
                  
                  const profile = await response.json();
                  profileCache.set(did, profile);
                  
                  // Clear cache after 24 hours
                  setTimeout(() => profileCache.delete(did), 1000 * 60 * 60 * 24);
                  
                  return profile;
                } catch (error) {
                  console.error('Error fetching profile:', error);
                  return null;
                }
              }

              function connectWebSocket() {
                const searchTerm = searchInput.value;
                const speed = speedInput.value;
                const protocol = "${process?.env?.NODE_ENV === 'production' ? 'wss' : 'ws'}";
                const wsUrl = \`\${protocol}://\${window.location.host}/ws?search=\${encodeURIComponent(searchTerm)}&speed=\${speed}\`;
                
                if (ws) {
                  ws.close();
                }

                ws = new WebSocket(wsUrl);
                
                ws.onmessage = async (event) => {
                  const post = JSON.parse(event.data);
                  await addPost(post);
                };
              }

              async function addPost(post) {
                const clone = postTemplate.content.cloneNode(true);
                
                let profile = post.author;
                if (!profile) {
                  profile = await fetchProfile(post.did);
                }
                
                const img = clone.querySelector('.post-avatar');
                if (profile?.avatar) {
                  img.src = profile.avatar;
                  img.alt = profile.displayName || 'Unknown';
                } else {
                  img.src = \`https://ui-avatars.com/api/?name=\${profile?.displayName || post.did}\`; // Add a default avatar
                  img.alt = 'Unknown user';
                }

                clone.querySelector('.post-author-name').textContent = profile?.displayName || 'Unknown';
                clone.querySelector('.post-author-handle .handle').textContent = profile?.handle || post.did;
                clone.querySelector('.post-content').textContent = post.text;
                
                const time = new Date(post.createdAt);
                clone.querySelector('.post-time').textContent = time.toLocaleTimeString();
                
                const profileLink = clone.querySelector('.post-author-handle');
                profileLink.href = profile?.handle ? 
                  \`https://bsky.app/profile/\${profile.handle}\` : 
                  \`https://bsky.app/profile/\${post.did}\`;
                
                const postLink = clone.querySelector('.post-link');
                postLink.href = post.url;

                posts.insertBefore(clone, posts.firstChild);
                
                while (posts.children.length > 50) {
                  posts.removeChild(posts.lastChild);
                }
              }

              speedInput.addEventListener('input', (e) => {
                speedValue.textContent = e.target.value;
              });

              let debounceTimeout;
              function debounceReconnect() {
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(connectWebSocket, 500);
              }

              searchInput.addEventListener('input', debounceReconnect);
              speedInput.addEventListener('change', debounceReconnect);

              connectWebSocket();
            `,
          }}
        ></script>
      </body>
    </html>
  )
})

export default {
  fetch: app.fetch,
  websocket,
}
