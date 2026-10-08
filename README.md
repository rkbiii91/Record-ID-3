# Vinyl ID

Take a photo of a vinyl record label with your phone → AI reads the artist/title/catalog#/runout →
looks it up on Discogs → shows tracklist, label, year, current marketplace price, and any YouTube
videos linked on the release page.

## What you need before deploying

1. **An Anthropic API key** — for the image-reading step.
   Get one at https://console.anthropic.com/settings/keys (pay-as-you-go; this app's photo
   requests cost a small fraction of a cent each).
2. **Your Discogs personal access token** (you said you already have one).
   If you ever need a new one: https://www.discogs.com/settings/developers

## Important limitation (read this)

Discogs' public API gives you the **current lowest asking price** and **number of copies for
sale** for a release — it does **not** expose "last sold price" or "median sold price" through
the API. Those sales-history numbers only exist on the Discogs website itself. This app links
straight to the release's marketplace page so you can see that history yourself with one tap,
rather than faking numbers it can't actually retrieve.

## Running it locally (to test before deploying)

```bash
npm install
cp .env.example .env
# open .env and paste in your two keys
npm start
```

Then open http://localhost:3000 in your browser. On your phone, camera capture only works
over HTTPS (or localhost), so for real phone use you need it deployed — see below.

## Deploying so you can use it on your phone (free option: Render)

1. Put this project in a GitHub repo (create a new repo, push these files).
2. Go to https://render.com → sign up (free) → **New +** → **Web Service**.
3. Connect your GitHub repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Under **Environment**, add these two variables (values from your keys above):
   - `ANTHROPIC_API_KEY`
   - `DISCOGS_TOKEN`
6. Deploy. Render gives you a URL like `https://vinyl-id.onrender.com`.
7. On your phone, open that URL in Safari/Chrome → tap Share (or menu) → **Add to Home Screen**.
   It now behaves like an installed app with its own icon.

(Render's free tier sleeps after inactivity, so the first request after a while takes ~30
seconds to wake up — fine for occasional personal use. Railway or Fly.io work the same way if
you'd rather use those.)

## How to use it

1. Tap the app icon, take/choose a photo of the record label.
2. Tap "Identify Record" — it'll try to read the artist, title, label, catalog #, and the
   runout/matrix etched near the center hole.
3. **Check the fields it filled in, especially the runout number** — that text is etched by
   hand or machine and is often faint or inconsistent, so AI reading of it is best-effort, not
   guaranteed. Fix anything wrong before searching.
4. Tap "Search Discogs" and pick the correct release from the results.
5. See the full tracklist, label, year, current marketplace price/link, and any videos.

## Project structure

```
vinyl-id-app/
  server.js          # Express backend: vision API + Discogs API calls
  package.json
  .env.example        # copy to .env with your real keys (never commit .env)
  public/
    index.html         # the app's single page
    app.js              # camera capture + calls to the backend
    style.css
    manifest.json       # makes it installable on your phone
    sw.js               # minimal service worker
```
