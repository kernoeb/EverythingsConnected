# EverythingsConnected (v2)

A modern, interactive visualization of the hidden connections between Spotify artists.
**Explore the musical graph: search for an artist and watch the network of collaborations grow.**

> **Note:** This project is a complete rewrite and fork of [EverythingsConnected](https://github.com/donovanwest/EverythingsConnected) by Donovan West. While the core concept remains the same, this version is built with a modern tech stack (Vue 3, Vite) and includes new features like dynamic expansion, user login, and improved performance.

## 🚀 Features

-   **Interactive Force Graph:** Visualize artists as nodes and collaborations as links using D3.js.
-   **Dynamic Expansion:** Automatically discovers and adds related artists based on collaborations (featuring on the same track).
-   **Spotify Integration:**
    -   **Search:** Find any artist on Spotify.
    -   **Player:** Listen to the tracks that connect two artists directly in the app.
    -   **User Login:** Log in with Spotify to visualize your **Followed Artists**.
-   **Customizable Visualization:**
    -   Toggle between Force-Directed and Tree layouts.
    -   Size nodes by popularity.
    -   Adjust search depth and expansion.
-   **Queue System:** Efficiently manages API rate limits and data fetching using a priority queue.

## 🛠️ Tech Stack

-   **Frontend:** [Vue 3](https://vuejs.org/) (Composition API, TypeScript)
-   **Build Tool:** [Vite](https://vitejs.dev/)
-   **Styling:** [TailwindCSS](https://tailwindcss.com/) & [DaisyUI](https://daisyui.com/)
-   **Visualization:** [D3.js](https://d3js.org/)
-   **Backend / Proxy:** [Bun](https://bun.sh/) (Simple token server)
-   **State/Logic:** `tinyqueue` for graph traversal, `@vueuse/core`.

## ⚙️ Setup & Installation

### Prerequisites

-   [Bun](https://bun.sh/) (Recommended for server & package management) or Node.js
-   A Spotify Developer Account and App (to get Client ID and Secret).

### 1. Clone the Repository

```bash
git clone https://github.com/kernoeb/EverythingsConnected
cd EverythingsConnected
```

### 2. Install Dependencies

```bash
bun install
# or
npm install
```

### 3. Environment Variables

Create a `.env` file in the root directory. You will need a Spotify Client ID and Secret from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/).

**Important:** Ensure you add `http://localhost:5173` (frontend) and `http://127.0.0.1:5173` (for PKCE) to your Spotify App's **Redirect URIs**.

```env
# For the Backend Token Server (server.ts)
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# For the Frontend (Vite)
VITE_SPOTIFY_CLIENT_ID=your_spotify_client_id
```

### 4. Run the Application

You need to run both the backend (for token exchange) and the frontend.

**Start the Token Server (Backend):**
```bash
bun run server
```
*Runs on port 3001.*

**Start the Frontend:**
```bash
bun run dev
# or
npm run dev
```
*Runs on port 5173 (default).*

## 📖 How it Works

1.  **Guest Mode:** The app uses the local Bun server (`server.ts`) to fetch a "Client Credentials" token. This allows searching and viewing the graph but not accessing user-specific data.
2.  **User Mode:** Users can log in via Spotify (OAuth PKCE). This grants access to `user-follow-read` scope, allowing the user to seed the graph with their followed artists.
3.  **Graph Logic:**
    -   When an artist is added, the app fetches their albums.
    -   It scans tracks on those albums for other artists.
    -   If a collaboration is found, a link is drawn between the artists.
    -   New artists are added to a priority queue to be processed and expanded further.

## 📄 License

This project is open source. Please refer to the license of the original repository or the included LICENSE file (if available).
