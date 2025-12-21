<script setup lang="ts">
import TinyQueue from 'tinyqueue'
import { onMounted, reactive, ref, watchEffect } from 'vue'
import ForceGraph from './components/ForceGraph.vue'
import { useSpotifyApi } from './composables/useSpotifyApi'

const api = useSpotifyApi()
const { isLoggedIn } = api
const nodes = ref<any[]>([])
const links = ref<any[]>([])
const artistInput = ref('')
const loadingCount = ref(0)
const loading = ref(false) // Computed alias
const queueLength = ref(0)
const processingName = ref('')
const isProcessing = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

watchEffect(() => loading.value = loadingCount.value > 0 || isProcessing.value || queueLength.value > 0)

const activeEmbed = ref<string | null>(null)

const options = reactive({
  layout: 'force',
  showImages: true,
  popSize: true,
  showLeaves: true,
  fullSearch: false,
  degrees: 2,
})

const checkedArtistIds = new Set<string>()
const processedArtistIds = new Set<string>()
let queue = new TinyQueue<any>([], (a, b) => a.priority - b.priority)

onMounted(async () => {
  // Focus the input
  searchInput.value?.focus()

  // Check for authorization code (PKCE)
  const searchParams = new URLSearchParams(window.location.search)
  const code = searchParams.get('code')

  if (code) {
    console.log('[App] Found code in URL, exchanging for token...')
    await api.exchangeToken(code)
    // Remove code from URL
    window.history.replaceState({}, document.title, window.location.pathname)
  } else {
    // Check for token in URL hash (OAuth redirect - Legacy/Implicit)
    const hash = window.location.hash
    console.log('[App] onMounted. Hash:', hash)
    if (hash) {
      const token = new URLSearchParams(hash.substring(1)).get('access_token')
      if (token) {
        console.log('[App] Found token in hash, setting it.')
        api.setToken(token, true)
      }
    } else {
      // Attempt to get generic token from our Bun server
      if (!api.isLoggedIn.value) {
        try {
          console.log('[App] No hash and not logged in, trying local token server...')
          const res = await fetch(`${window.location.origin}/accessToken`)
          if (res.ok) {
            const token = await res.text()
            console.log('[App] Got token from local server.')
            api.setToken(token, false)
          } else {
            console.log('[App] Local token server returned non-OK status:', res.status)
          }
        } catch (e) {
          console.error('[App] Local token server not running or failed.', e)
        }
      } else {
        console.log('[App] Already logged in, skipping generic token fetch.')
      }
    }
  }
})

async function startSearch() {
  const query = artistInput.value
  if (!query) return

  artistInput.value = '' // Clear immediately for instant feedback
  loadingCount.value++

  try {
    const artist = await api.searchArtist(query)
    if (!artist) {
      alert('Artist not found')
      return
    }

    addArtistToGraph(artist, 0, 'searched', true)
    processQueue()
  } finally {
    loadingCount.value--
  }
}

async function addRandomArtist() {
  loadingCount.value++
  try {
    const artist = await api.getRandomArtist()
    if (artist) {
      addArtistToGraph(artist, 0, 'random', true)
      processQueue()
    }
  } finally {
    loadingCount.value--
  }
}

async function addFollowedArtists() {
  if (!isLoggedIn.value) return

  loadingCount.value++
  try {
    const artists = await api.getFollowedArtists()
    if (artists.length === 0) {
      alert('You haven\'t followed any artists!')
    } else {
      artists.forEach((artist) => {
        // Only queue if we want a full search, otherwise just add the nodes
        addArtistToGraph(artist, 0, 'followed', options.fullSearch)
      })
      if (options.fullSearch) {
        processQueue()
      }
    }
  } finally {
    loadingCount.value--
  }
}

function addArtistToGraph(artist: any, priority: number, source: string = 'related', shouldQueue: boolean = true) {
  if (checkedArtistIds.has(artist.id)) {
    // If we are explicitly searching for an existing artist, update source and expand
    if (source === 'searched') {
      const existing = nodes.value.find(n => n.id === artist.id)
      if (existing) {
        existing.source = 'searched'
        if (shouldQueue) {
          queue.push({ id: artist.id, priority })
          queueLength.value = queue.length
        }
      }
    }
    return
  }

  nodes.value.push({
    id: artist.id,
    name: artist.name,
    image: artist.images?.[2]?.url || artist.images?.[1]?.url || artist.images?.[0]?.url || artist.image,
    popularity: artist.popularity,
    priority,
    degree: 0,
    source, // 'searched', 'clicked', 'related'
  })

  checkedArtistIds.add(artist.id)
  if (shouldQueue) {
    queue.push({ id: artist.id, priority })
    queueLength.value = queue.length
  }
}

async function processQueue() {
  if (isProcessing.value) return
  isProcessing.value = true

  try {
    while (queue.length > 0) {
      const current = queue.pop()
      console.log(current)
      queueLength.value = queue.length

      // Skip if already processed to prevent cycles/redundant API calls
      if (processedArtistIds.has(current.id)) {
        console.log('Skipping already processed artist:', current.id)
        continue
      };

      console.log('Processing artist:', current.id)

      // Find name for display
      const node = nodes.value.find(n => n.id === current.id)
      processingName.value = node ? node.name : current.id

      // Check depth limits
      // Since queue is sorted by priority (low to high), if current exceeds limit, all subsequent items will too.
      // We clear the queue to stop the "loading" indicator and exit.
      if ((!options.fullSearch && current.priority > 0) || (options.fullSearch && current.priority >= options.degrees)) {
        queue = new TinyQueue<any>([], (a, b) => a.priority - b.priority)
        console.log('Reached depth limit', current.id)
        break
      }

      processedArtistIds.add(current.id)

      const albumIds = await api.getArtistAlbums(current.id)
      const connected = await api.getArtistsFromAlbums(albumIds, current.id)
      const details = await api.getArtistsDetails(connected.map(c => c.artistId))

      connected.forEach((conn, idx) => {
        const detail = details[idx]

        // Add node if new
        if (!checkedArtistIds.has(conn.artistId)) {
          addArtistToGraph({ ...detail, id: conn.artistId }, current.priority + 1, 'related')
        }

        // Add link
        const linkExists = links.value.some(l =>
          (l.source === current.id && l.target === conn.artistId)
          || (l.source === conn.artistId && l.target === current.id),
        )

        if (!linkExists) {
          links.value.push({
            source: current.id,
            target: conn.artistId,
            trackName: conn.trackName,
            trackLink: conn.trackLink,
          })

          // Update degrees for filtering
          const s = nodes.value.find(n => n.id === current.id)
          const t = nodes.value.find(n => n.id === conn.artistId)
          if (s) s.degree++
          if (t) t.degree++
        }
      })
    }
  } finally {
    isProcessing.value = false
    processingName.value = ''
    queueLength.value = queue.length
  }
}

function handleLinkClick(link: any) {
  activeEmbed.value = link.trackLink
}

function handleNodeClick(node: any) {
  console.log(node)

  // Mark node as clicked? Or just expand.
  // We can update the node's source property if we want to highlight it as 'clicked'
  const targetNode = nodes.value.find(n => n.id === node.id)
  if (targetNode && targetNode.source !== 'searched') {
    targetNode.source = 'clicked'
  }

  queue.push({ id: node.id, priority: 0 })
  queueLength.value = queue.length
  processQueue()
}

function stopProcessing() {
  queue = new TinyQueue<any>([], (a, b) => a.priority - b.priority)
  queueLength.value = 0
}

function reloadPage() {
  window.location.reload()
}
</script>

<template>
  <div class="drawer lg:drawer-open">
    <input id="my-drawer" class="drawer-toggle" type="checkbox">

    <div class="drawer-content flex flex-col h-screen overflow-hidden">
      <!-- Navbar -->
      <nav class="navbar w-full bg-base-100 border-b border-base-200 z-30">
        <div class="flex-none lg:hidden">
          <label aria-label="open sidebar" class="btn btn-square btn-ghost" for="my-drawer">
            <svg class="inline-block w-6 h-6 stroke-current" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" /></svg>
          </label>
        </div>
        <div class="flex-1 px-2 mx-2">
          <h1 class="text-xl font-bold tracking-tight text-gray-900">
            Everything's Connected
          </h1>
        </div>
      </nav>

      <!-- Main Page Content -->
      <div class="relative flex-grow overflow-hidden">
        <!-- Graph Component -->
        <ForceGraph
          :links="links"
          :nodes="nodes"
          :options="options"
          @link-click="handleLinkClick"
          @node-click="handleNodeClick"
        />

        <!-- Empty State -->
        <div v-if="nodes.length === 0" class="absolute inset-0 flex items-center justify-center bg-base-100/50 backdrop-blur-sm z-40 pointer-events-none">
          <div class="text-center max-w-md p-6 pointer-events-auto">
            <div class="mb-4 inline-block p-4 rounded-full bg-primary/10 text-primary">
              <svg class="w-12 h-12" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S13.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <h2 class="text-4xl font-bold tracking-tight text-base-content mb-2">
              Welcome to Everything's Connected.
            </h2>
            <p class="text-base-content/60 text-lg mb-6">
              Visualize the hidden connections between your favorite artists.
              Start by searching for a musician in the sidebar.
            </p>
            <div class="flex justify-center gap-2 text-sm text-base-content/40">
              <span>Powered by Spotify Web API</span>
            </div>
          </div>
        </div>

        <!-- Overlay Loader & Queue Status -->
        <div v-if="loading || queueLength > 0" class="absolute top-4 right-4 flex flex-col gap-2 pointer-events-none select-none z-50">
          <div class="flex items-center gap-3 bg-base-100/90 backdrop-blur-md p-3 rounded-xl border border-base-content/10 shadow-lg pointer-events-auto">
            <span v-if="loading" class="loading loading-spinner loading-md text-primary" />

            <div class="flex flex-col items-end min-w-[100px]">
              <div v-if="queueLength > 0" class="flex items-center gap-2">
                <span class="font-black text-xs uppercase tracking-wider text-base-content/70">Queue</span>
                <span class="badge badge-primary badge-sm font-mono">{{ queueLength }}</span>
              </div>
              <div v-else class="text-xs font-bold text-base-content/50 uppercase tracking-wider">
                Processing
              </div>

              <span v-if="processingName" class="text-xs font-bold text-base-content truncate max-w-[150px] animate-pulse">
                {{ processingName }}
              </span>
            </div>

            <button class="btn btn-ghost btn-xs btn-circle text-error" title="Clear Queue" @click="stopProcessing">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 18L18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Player Embed -->
        <div v-if="activeEmbed" class="absolute bottom-0 left-0 right-0 p-4 bg-base-300/80 backdrop-blur z-50">
          <div class="flex justify-between items-center max-w-2xl mx-auto">
            <iframe allow="encrypted-media" frameborder="0" height="80" :src="activeEmbed" width="100%" />
            <button class="btn btn-ghost btn-circle" @click="activeEmbed = null">
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <div class="drawer-side z-50">
      <label class="drawer-overlay" for="my-drawer" />
      <div class="p-4 w-80 min-h-full bg-base-200 text-base-content flex flex-col gap-6">
        <!-- Title hidden on desktop since it's in nav, visible in drawer for mobile if needed?
             Actually, standard pattern is usually just controls in sidebar.
             Let's keep the controls. -->
        <div class="lg:hidden text-xl font-bold tracking-tight text-gray-900 mb-2">
          Connected.
        </div>

        <div class="form-control">
          <div class="join">
            <input ref="searchInput" v-model="artistInput" autofocus class="input input-bordered join-item w-full" placeholder="Artist Name..." @keyup.enter="startSearch">
            <button class="btn btn-primary join-item" @click="startSearch">
              Search
            </button>
          </div>
        </div>

        <div class="divider">
          Options
        </div>

        <div class="flex flex-col gap-2">
          <!-- Layout Selection -->
          <div class="join w-full">
            <input v-model="options.layout" aria-label="Force" class="join-item btn btn-sm w-1/2" name="layout" type="radio" value="force">
            <input v-model="options.layout" aria-label="Tree" class="join-item btn btn-sm w-1/2" name="layout" type="radio" value="dagre">
          </div>

          <label class="label cursor-pointer justify-start gap-4">
            <input v-model="options.fullSearch" class="checkbox checkbox-primary" type="checkbox">
            <span class="label-text">Full Search</span>
          </label>

          <div v-if="options.fullSearch" class="px-2">
            <span class="text-xs">Degrees: {{ options.degrees }}</span>
            <input v-model="options.degrees" class="range range-xs" max="5" min="1" type="range">
          </div>

          <label class="label cursor-pointer justify-start gap-4">
            <input v-model="options.showImages" class="checkbox checkbox-secondary" type="checkbox">
            <span class="label-text">Show Images</span>
          </label>

          <label class="label cursor-pointer justify-start gap-4">
            <input v-model="options.popSize" class="checkbox checkbox-secondary" type="checkbox">
            <span class="label-text">Size by Popularity</span>
          </label>

          <label class="label cursor-pointer justify-start gap-4">
            <input v-model="options.showLeaves" class="checkbox checkbox-secondary" type="checkbox">
            <span class="label-text">Show Leaves</span>
          </label>
        </div>

        <div class="mt-auto flex flex-col gap-2">
          <button class="btn btn-outline btn-sm" @click="addRandomArtist">
            Add Random Artist
          </button>

          <div v-if="isLoggedIn" class="contents">
            <button class="btn btn-outline btn-sm" @click="addFollowedArtists">
              Add Followed Artists
            </button>
          </div>

          <button v-if="!isLoggedIn" class="btn btn-outline btn-sm" @click="api.login">
            Login for User Data
          </button>
          <button class="btn btn-outline btn-error btn-sm" @click="reloadPage()">
            Reset Graph
          </button>
          <div class="text-center text-xs opacity-50">
            Total Artists: {{ nodes.length }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
