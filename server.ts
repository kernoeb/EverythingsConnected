const PORT = 3001

// You would typically put these in .env
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/accessToken') {
      if (!CLIENT_SECRET) {
        return new Response('Client Secret not set on server', { status: 500 })
      }

      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      })

      const data = await res.json()
      return new Response(data.access_token, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    }

    // Serve static files from ./dist
    const distPath = './dist'
    let filePath = url.pathname
    if (filePath === '/') filePath = '/index.html'

    const file = Bun.file(distPath + filePath)
    if (await file.exists()) {
      return new Response(file)
    }

    // SPA fallback: serve index.html for any other route
    return new Response(Bun.file(`${distPath}/index.html`))
  },
})

console.log(`Bun token server running on http://localhost:${PORT}`)
