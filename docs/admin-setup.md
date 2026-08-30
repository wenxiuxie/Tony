# Setting up the admin

The admin lets Tony and you edit every word, image and video on both pages
from a browser, with no GitHub account and no git. This document is the
one-time setup.

**Read the ordering warning first — step 1 is not optional.**

---

## ⚠️ Do step 1 before pushing this branch

The site is no longer plain static files at the repo root. `index.html` and
`zh/index.html` are now **generated** from `content/*.json` and are no longer
committed. If you push this branch while Cloudflare Pages is still set to
"no build command, serve the repo root", **the live site will 404**, because
there is no `index.html` in the repo any more.

Change the Pages build settings first, then push.

---

## 1. Cloudflare Pages build settings

Dashboard → Workers & Pages → your project → Settings → Builds & deployments.

| Setting | Value |
|---|---|
| Build command | `python build.py --dist` |
| Build output directory | `dist` |
| Root directory | *(leave empty)* |

Nothing else changes. There is no `requirements.txt` — `build.py` uses only
the standard library, so the build is a few seconds.

`dist/` contains the two rendered pages plus `css/`, `js/`, `img/`, `fonts/`
and `admin/`. It deliberately does **not** contain `content/`, `build.py`,
`tools/` or `workers/`, so none of the source is served publicly.

## 2. A custom domain

You need one, for two independent reasons:

- Worker routes only attach to a zone you control, so `/api/admin/*` cannot
  work on a bare `*.pages.dev` address.
- `*.pages.dev` is the hostname most likely to be outright blocked in
  mainland China. A proxied custom domain is merely slow there.

Pages → your project → Custom domains → add yours, and let Cloudflare manage
the DNS.

## 3. Cloudflare Access

Zero Trust dashboard → Access → Applications → **Add an application** →
Self-hosted.

- **Application domain:** `yourdomain.com` with path `admin`
- **Add a second domain** on the same application: `yourdomain.com` path
  `api/admin` — the UI and the API must both be behind Access.
- **Identity provider:** One-time PIN is enough. It emails a code; no
  password, no account to create.
- **Policy:** Action *Allow*, include → *Emails* → your address and Tony's.
- **Session duration:** 24 hours is a reasonable balance.

Then, from the application's Overview tab, copy the **Application Audience
(AUD) Tag**. You need it in step 5.

Your **team domain** is on Zero Trust → Settings → Custom Pages, and looks
like `something.cloudflareaccess.com`.

> Check that the one-time PIN email actually arrives at the address Tony
> will use. Delivery to QQ Mail and 163 can be slow or filtered; an Outlook
> or Gmail address is the safer choice.

## 4. A GitHub token

github.com → Settings → Developer settings → **Fine-grained personal access
tokens** → Generate new token.

- **Repository access:** Only select repositories → `Tony_Deng_Website`
- **Permissions:** Repository permissions → **Contents: Read and write**
  (that is the only one needed)
- **Expiration:** set a calendar reminder for whatever you pick — the admin
  stops saving the day it expires, with a GitHub 401 in the error toast.

This token lives only in the Worker. It is never sent to the browser, which
is the whole reason the admin works from China.

## 5. Deploy the Worker

You need Node installed for `wrangler` (there is currently no Node on this
machine — <https://nodejs.org>, LTS is fine).

```
cd workers/admin
```

Edit `wrangler.toml` and fill in:

- `routes` — your domain, e.g. `tonydeng.com/api/admin/*`
- `ACCESS_TEAM_DOMAIN` — from step 3
- `ACCESS_AUD` — from step 3
- `PUBLISHERS` — the emails allowed to push changes live

Then:

```
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # paste the token from step 4
npx wrangler deploy
```

## 6. Push

```
git push -u origin admin        # or merge into main once you are happy
```

Pages builds, and `https://yourdomain.com/admin/` prompts for an Access
code.

---

## How it works day to day

```
Tony ──login──▶ Cloudflare Access ──▶ /admin ──▶ Worker ──commit──▶ draft branch
                 (email code)                     (holds token)         │
                                                                        ▼
       you ──▶ Publish ──▶ merge draft → main ──▶ Pages build ──▶ live site
```

- **Save draft** commits to the `draft` branch. Cloudflare Pages builds a
  preview URL for that branch automatically, so changes are visible on a
  real page straight away without touching the live site.
- **Publish** merges `draft` into `main`. Only emails in `PUBLISHERS` see it
  enabled; everyone else gets edit-and-preview.
- Every save is an ordinary git commit, attributed to whoever made it and
  revertable with `git revert`.

The draft branch is created automatically the first time the admin loads.

## Roles

| | Tony (editor) | You (publisher) |
|---|---|---|
| Edit every field | ✅ | ✅ |
| Upload images | ✅ | ✅ |
| See it on the preview URL | ✅ | ✅ |
| Change the live site | ❌ | ✅ |

To let Tony publish too, add his email to `PUBLISHERS` in `wrangler.toml`
and redeploy. To give someone access at all, add them to the Access policy
in step 3 — the Worker only ever sees people Access has already let through.

## Trying it without deploying anything

```
python tools/devserver.py
```

Serves the site and a local stand-in for the admin API at
<http://localhost:5502/admin/>, writing straight to `content/*.json` on disk
and rebuilding after each save. **No authentication** — localhost only, for
trying things before they go anywhere.

## When something breaks

| Symptom | Cause |
|---|---|
| Live site 404s after a push | Step 1 was skipped — set the build command |
| "Not signed in" in the admin | The `/api/admin` route is not covered by the Access application (step 3) |
| "Access token is for a different application" | `ACCESS_AUD` does not match the app's AUD tag |
| GitHub 401 in the error toast | The token expired or was revoked — issue a new one and `wrangler secret put` it again |
| "Someone else saved while you were editing" | Two people edited at once. Reload, re-apply your change. Nothing was lost |
| Publish greyed out | You have unsaved changes, nothing to publish, or you are not in `PUBLISHERS` |

## What the admin cannot do

Deliberately out of scope, because each would need a human with git:

- Changing the page structure — section order, new sections, layout
- Editing CSS or JavaScript
- Deleting images from the repo (uploading a replacement is enough; old
  files just sit there)
- Resolving a merge conflict between `draft` and `main`
