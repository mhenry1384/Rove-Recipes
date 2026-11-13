# Rove Recipes

A small installable web app (PWA) for viewing Markdown recipes stored in a Google Drive folder.

- Lists every `.md` file in the folder. Search matches recipe names first, then recipe text.
- Shows recipes as formatted Markdown.
- Records the last time you made each recipe in `Last Made.txt` in the same folder. Each line is `YYYY-MM-DD  Recipe name`, so you can read or edit it by hand.
- Works offline with the last synced copy. A "made it" tap made while offline is saved the next time you sync.
- Keeps the screen on while a recipe is open. This can be turned off.
- Plain HTML/CSS/JS with no build step. Markdown rendering uses the copies of `marked` and `DOMPurify` in `vendor/`.

## Google permissions

The app asks for two Drive scopes:

- `drive.readonly`: lets it read the recipes.
- `drive.file`: lets it create and edit only the files it created itself, which means `Last Made.txt`.

So the app can never change or delete your recipes. Because of `drive.file`, the app can't update a `Last Made.txt` that it didn't create. If you ever make one by hand, delete it and let the app create its own. Editing the app-created file afterwards is fine.

## One-time setup

### 1. Google Cloud OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (for example "Rove Recipes").
2. Go to **APIs & Services → Library**, find **Google Drive API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (now called "Google Auth Platform"):
   - User type: **External**. Fill in the app name and your email.
   - **Data access / Scopes**: add `.../auth/drive.readonly` and `.../auth/drive.file`.
   - **Audience / Test users**: add your own Google account. Leave the app in **Testing**; it doesn't need to be published or verified for personal use. Google will show an "unverified app" warning the first time you sign in. Click *Continue*.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**:
     - `https://YOUR-GITHUB-USERNAME.github.io` (enter only the origin, with no repo path)
     - `http://localhost:8080` (for testing locally)
   - You don't need any redirect URIs.
5. Copy the **Client ID** into `CLIENT_ID` in `config.js`.

### 2. Recipe folder

Open the Recipes folder at drive.google.com. The URL looks like
`https://drive.google.com/drive/folders/1AbCdEf...`. Paste the part after `/folders/` into
`FOLDER_ID` in `config.js`. If you leave it blank, the app uses the first folder it finds named `Recipes`.

### 3. Host on GitHub Pages

1. Create a GitHub repo (for example `rove-recipes`) and push this folder to it.
2. In the repo, go to **Settings → Pages → Build and deployment**, set Source to **Deploy from a branch**, and pick `main` / `/ (root)`.
3. The app will be at `https://YOUR-GITHUB-USERNAME.github.io/rove-recipes/`.

All paths in the app are relative, so it works from a repo subpath. The client ID in `config.js` is not a secret. It's fine for it to be in a public repo because Google only accepts it from the origins you listed.

### Running locally

```
npx serve -l 8080 .
```
or `python -m http.server 8080`, then open <http://localhost:8080>.

## Installing the app

- **Windows / Mac (Chrome or Edge):** click the install icon in the address bar, or use the menu → *Install Rove Recipes*.
- **Mac (Safari 17+):** File → *Add to Dock*.
- **Android (Chrome):** menu → *Add to Home screen* / *Install app*.

## Notes

- Google sign-in tokens last about an hour. Recipes stay readable without one. When the token has expired, tapping **Sync** or **I made this today** signs you back in, usually without asking anything.
- Only recipes that changed in Drive are downloaded again on each sync.
- **Releasing updates:** increase `APP_VERSION` in `version.js` on every push. The number appears next to the app name, and it also names the service-worker cache, so installed copies drop their old files.
