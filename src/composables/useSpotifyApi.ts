import { ref, watchEffect } from 'vue'

const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID

// Global State
const accessToken = ref<string | null>(sessionStorage.getItem('spotify_access_token'))
const isLoggedIn = ref(sessionStorage.getItem('spotify_is_logged_in') === 'true')

// Persist state
watchEffect(() => {
  if (accessToken.value) {
    console.log('[useSpotifyApi] Token updated/watched:', `${accessToken.value.slice(0, 10)}...`)
    sessionStorage.setItem('spotify_access_token', accessToken.value)
  } else {
    // Only clear if explicitly null, but be careful not to clear on initial load if null but not yet set?
    // Actually, if it's null, we probably want to ensure storage is clear.
    // But initially it loads FROM storage.
    // If we set it to null programmatically (logout), we want to clear storage.
  }
})

// PKCE Helpers
function generateRandomString(length: number) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return values.reduce((acc, x) => acc + possible[x % possible.length], '')
}

async function sha256(plain: string) {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return window.crypto.subtle.digest('SHA-256', data)
}

function base64encode(input: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export function useSpotifyApi() {
  const setToken = (token: string, isUser: boolean = false) => {
    console.log('[useSpotifyApi] setToken called with:', `${token.slice(0, 10)}...`)
    accessToken.value = token
    // We don't need to manually set sessionStorage here because watchEffect handles it for token.
    // But we need to handle isLoggedIn.

    if (isUser) {
      isLoggedIn.value = true
      sessionStorage.setItem('spotify_is_logged_in', 'true')
    } else {
      // If setting a generic token, we don't necessarily want to set isLoggedIn to false immediately
      // if we are just refreshing the generic token?
      // No, if we explicitly set a token and say isUser=false, we are effectively saying "this is not a user session".
      // However, we usually only call this when we are sure.
      // For safety:
      // isLoggedIn.value = false;
      // sessionStorage.removeItem('spotify_is_logged_in');
    }
  }

  const fetchWithToken = async (endpoint: string, options: any = {}) => {
    if (!accessToken.value) {
      console.error('[useSpotifyApi] fetchWithToken called without token!')
    }
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${accessToken.value}`,
      },
    })
    if (res.status === 401) {
      console.warn('[useSpotifyApi] 401 Unauthorized. Clearing token and reloading...')
      sessionStorage.removeItem('spotify_access_token')
      sessionStorage.removeItem('spotify_is_logged_in')
      accessToken.value = null
      isLoggedIn.value = false
      window.location.reload()
    }
    return res.json()
  }

  const login = async () => {
    const codeVerifier = generateRandomString(64)
    const hashed = await sha256(codeVerifier)
    const codeChallenge = base64encode(hashed)

    window.sessionStorage.setItem('code_verifier', codeVerifier)

    const url = window.location.origin.replace('http://localhost:', 'http://127.0.0.1:')
    const scopes = ['user-follow-read']

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID as string,
      scope: scopes.join(','),
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      redirect_uri: url,
    })

    window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`
  }

  const exchangeToken = async (code: string) => {
    const codeVerifier = window.sessionStorage.getItem('code_verifier')
    const url = window.location.origin.replace('http://localhost:', 'http://127.0.0.1:')

    if (!codeVerifier) {
      console.error('No code verifier found!')
      return
    }

    const payload = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID as string,
        grant_type: 'authorization_code',
        code,
        redirect_uri: url,
        code_verifier: codeVerifier,
      }),
    }

    const body = await fetch('https://accounts.spotify.com/api/token', payload)
    const response = await body.json()

    if (response.access_token) {
      setToken(response.access_token, true)
    } else {
      console.error('Failed to exchange token', response)
    }
  }

  const searchArtist = async (name: string) => {
    const trimmedName = name.trim()

    // 1. Try exact artist match with quotes (High precision, good for "Sia")
    let data = await fetchWithToken(`/search?q=${encodeURIComponent(`artist:"${trimmedName}"`)}&type=artist&limit=1`)

    if (data.artists?.items && data.artists.items.length > 0) {
      return data.artists.items[0]
    }

    // 2. Fallback to fuzzy artist search (Good for "THÉA")
    console.warn(`[useSpotifyApi] Exact search for 'artist:"${trimmedName}"' failed, falling back to standard artist search.`)
    data = await fetchWithToken(`/search?q=${encodeURIComponent(`artist:${trimmedName}`)}&type=artist&limit=1`)

    return data.artists?.items[0]
  }

  const getArtistAlbums = async (artistId: string) => {
    let allAlbums: any[] = []
    let offset = 0

    while (true) {
      const data = await fetchWithToken(`/artists/${artistId}/albums?limit=50&offset=${offset}&include_groups=album,single,appears_on`)

      if (!data.items || data.items.length === 0) {
        break
      }

      allAlbums = [...allAlbums, ...data.items]

      // Safety Break: Limit to 100 albums to avoid massive API spam
      if (allAlbums.length >= 100 || !data.next) {
        break
      }

      offset += 50
    }
    // Return unique IDs
    return [...new Set(allAlbums.map(a => a.id))]
  }

  const getArtistsFromAlbums = async (albumIds: string[], targetArtistId: string) => {
    const chunks = []
    for (let i = 0; i < albumIds.length; i += 20) {
      chunks.push(albumIds.slice(i, i + 20))
    }

    const connections = new Map()

    for (const chunk of chunks) {
      const data = await fetchWithToken(`/albums?ids=${chunk.join(',')}`)
      data.albums.forEach((album: any) => {
        album.tracks.items.forEach((track: any) => {
          const artistList = track.artists.map((a: any) => a.id)
          if (artistList.length > 1 && artistList.includes(targetArtistId)) {
            track.artists.forEach((artist: any) => {
              if (artist.id !== targetArtistId && !connections.has(artist.id)) {
                connections.set(artist.id, {
                  artistId: artist.id,
                  artistName: artist.name,
                  trackName: `${track.name} by ${album.artists[0].name}`,
                  trackLink: track.external_urls.spotify.replace('/track/', '/embed/track/'),
                })
              }
            })
          }
        })
      })
    }
    return Array.from(connections.values())
  }

  const getArtistsDetails = async (ids: string[]) => {
    const chunks = []
    for (let i = 0; i < ids.length; i += 50) {
      chunks.push(ids.slice(i, i + 50))
    }
    let details: any[] = []
    for (const chunk of chunks) {
      const data = await fetchWithToken(`/artists?ids=${chunk.join(',')}`)
      details = [...details, ...data.artists]
    }
    return details.map(d => ({
      id: d.id,
      name: d.name,
      popularity: d.popularity,
      image: d.images?.[1]?.url || d.images?.[0]?.url || null,
    }))
  }

  const getFollowedArtists = async () => {
    let allArtists: any[] = []
    let after: string | null = null

    while (true) {
      const url = `/me/following?type=artist&limit=50${after ? `&after=${after}` : ''}`
      const data = await fetchWithToken(url)

      if (!data.artists || !data.artists.items || data.artists.items.length === 0) {
        break
      }

      allArtists = [...allArtists, ...data.artists.items]
      after = data.artists.cursors.after

      if (!after) break
    }

    return allArtists.map(d => ({
      id: d.id,
      name: d.name,
      popularity: d.popularity,
      image: d.images?.[1]?.url || d.images?.[0]?.url || null,
    }))
  }

  const getRandomArtist = async (): Promise<any> => {
    const charcs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']
    const charc = charcs[Math.floor(Math.random() * charcs.length)]
    const offset = Math.floor(Math.random() * 999)
    const searchString = `%${charc}%`

    const data = await fetchWithToken(`/search?q=${encodeURIComponent(searchString)}&type=artist&limit=1&offset=${offset}`)
    const artist = data.artists?.items[0]

    if (!artist || !artist.popularity || artist.popularity < 10) {
      // Retry
      return getRandomArtist()
    }

    const albumIds = await getArtistAlbums(artist.id)
    if (albumIds.length === 0) return getRandomArtist()

    return artist
  }

  return {
    setToken,
    login,
    exchangeToken,
    searchArtist,
    getArtistAlbums,
    getArtistsFromAlbums,
    getArtistsDetails,
    getFollowedArtists,
    getRandomArtist,
    isLoggedIn,
    accessToken,
  }
}
