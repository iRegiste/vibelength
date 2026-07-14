# VibeLength 🎵  
AI-assisted Spotify playlist generator

## Overview
VibeLength is a web app that generates Spotify playlists based on seed songs and natural-language prompts. You give it a few tracks or artists to start with, and VibeLength uses OpenAI to interpret your prompt (like “late-night study,” “sunset drive,” or “festival energy”) and the Spotify API to fill your playlist with similar tracks that match the vibe.

> **Live App:** https://vibelength.onrender.com/  
> **Access Note:** Due to Spotify API policy changes, individual developers can’t make apps public. If you want to test VibeLength, email **ianregister1@gmail.com** with your Spotify account email so I can add you to the **whitelist**.

---

## Features
- 🔐 **Secure Login (OAuth 2.0 PKCE)** — authenticate with your Spotify account
- 🧠 **AI Prompting** — describe a mood/setting; get a matching playlist
- 📊 **Audio Feature Awareness** — leverages tempo, energy, valence, danceability
- 📚 **Seed Blending** — mixes top tracks, artists, and genres with your prompt
- 💾 **One-Click Save** — creates the playlist in your Spotify library
- 🚀 **Deployed** — hosted on Render for easy access

---

## How It Works (High Level)
1. **Login:** You sign in with Spotify via PKCE; VibeLength receives an access token.
2. **Prompt:** You enter a natural-language description of the vibe you want.
3. **Curation:** The backend uses your top tracks/artists and Spotify recommendations, guided by the prompt.
4. **Create:** A playlist is created in your account with a fitting title and description.

---

## Tech Stack
- **Frontend:** HTML/CSS, JavaScript
- **Backend:** Node.js, Express
- **APIs:** Spotify Web API (+ OpenAI for prompt understanding/semantic intent)
- **Auth:** OAuth 2.0 PKCE
- **Hosting:** Render

---

## Getting Access (Whitelist Required)
Spotify now restricts public apps for individual developers. To try VibeLength:
1. Email **ianregister1@gmail.com** with the **email linked to your Spotify account**.
2. I’ll add you to the **allowed users** list.
3. Once approved, visit **https://vibelength.onrender.com/** and log in.
4. Alternatively, VibeLengthDemo.mp4 also shows the end to end flow

---

## Privacy
- Tokens are stored server-side/session-scoped and used only to create recommendations and playlists you request.
- VibeLength does **not** sell or share your listening data.
- You can revoke access anytime in your Spotify account settings.

---

## Roadmap
- ⏱️ Adjustable playlist length and time caps
- 🎚️ Sliders for energy/tempo/valence targets
- 🧩 Multi-prompt blending (“morning focus + afternoon pump”)
- 👯 Collaborative playlist mode

---

## Support & Contact
Questions, feedback, or whitelist access: **ianregister1@gmail.com**  

If you like VibeLength, star the repo and share prompt ideas!
