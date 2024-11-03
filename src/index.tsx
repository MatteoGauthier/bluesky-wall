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
  author: {
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

    let postQueue: CleanPost[] = []
    let intervalId: ReturnType<typeof setInterval>
    let unsubscribe: (() => void) | null = null

    return {
      onOpen: async (_evt, ws) => {
        console.log("Client connected")

        unsubscribe = BlueskyConnection.getInstance().subscribe(async (post) => {
          if (post.commit?.record?.text) {
            if (!searchTerm || post.commit.record.text.toLowerCase().includes(searchTerm)) {
              const profile = await getProfile(post.did)

              if (profile) {
                const cleanPost: CleanPost = {
                  id: post.commit.rkey,
                  cid: post.commit.cid,
                  text: post.commit.record.text,
                  createdAt: post.commit.record.createdAt,
                  url: `https://bsky.app/profile/${profile.handle}/post/${post.commit.rkey}`,
                  author: {
                    did: profile.did,
                    handle: profile.handle,
                    displayName: profile.displayName,
                    avatar: profile.avatar,
                  },
                  meta: {
                    queueSize: postQueue.length,
                  },
                }
                postQueue.push(cleanPost)
              }
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
        console.log("Client disconnected")
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
        <div class="fixed bottom-0 right-0 w-full p-4">
          <p>
            Made by{" "}
            <a href="https://bsky.social/matteogauthier.fr" class="text-blue-500 hover:underline" target="_blank">
              Mattèo Gauthier
            </a>
          </p>
          <a
            href="https://github.com/matteogauthier/bluesky-wall"
            class="text-sm text-gray-500 hover:underline"
            target="_blank"
          >
            View on GitHub
          </a>
        </div>

        <div class="max-w-2xl mx-auto p-4">
          <div class="bg-white rounded-lg shadow p-4 mb-4 sticky top-4">
            <h1 class="text-2xl font-bold mb-2">Bluesky Wall</h1>
            <p class="text-gray-500 mb-4 text-sm">
              This website let you see the latest posts from a given search term on Bluesky. Make it perfect for
              conferences, events, live coding, etc. 
            </p>

            <div class="space-y-4">
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

              function connectWebSocket() {
                const searchTerm = searchInput.value;
                const speed = speedInput.value;
                const wsUrl = \`ws://\${window.location.host}/ws?search=\${encodeURIComponent(searchTerm)}&speed=\${speed}\`;
                
                if (ws) {
                  ws.close();
                }

                ws = new WebSocket(wsUrl);
                
                ws.onmessage = (event) => {
                  const post = JSON.parse(event.data);
                  addPost(post);
                };
              }

              function addPost(post) {
                const clone = postTemplate.content.cloneNode(true);
                
                const img = clone.querySelector('.post-avatar');
                img.src = post.author.avatar;
                img.alt = post.author.displayName;

                clone.querySelector('.post-author-name').textContent = post.author.displayName;
                clone.querySelector('.post-author-handle .handle').textContent = post.author.handle;
                clone.querySelector('.post-content').textContent = post.text;
                
                const time = new Date(post.createdAt);
                clone.querySelector('.post-time').textContent = time.toLocaleTimeString();
                
                const profileLink = clone.querySelector('.post-author-handle');
                profileLink.href = \`https://bsky.app/profile/\${post.author.handle}\`;
                
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
