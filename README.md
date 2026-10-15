# Router Hub

Stores the final router installers per client, keeps every version, and hands out download links.

- **Master** signs in, uploads, and copies links that download with **no password**.
- **Helper** signs in, browses, and copies links that ask for the **download password** the master set.

## Run it

```
start.bat
```

or `npm start`. The first run creates `.env` with generated passwords for the two accounts, starts
MongoDB, and serves the app at <http://localhost:4600>. Sign-in details are the `MASTER_*` and
`HELPER_*` lines in `.env`; after the first start, change passwords in the app under **Settings**.

Fresh checkout on another machine: `npm run setup` (installs dependencies and builds the interface), then `start.bat`.

### MongoDB

`MONGO_URI` in `.env` decides which database is used.

- Pointing at a server that is already running (local service, another host, Atlas): it is used as is.
- Pointing at localhost with nothing listening: a portable `mongod` is started from `.runtime\`, with
  its data in `.data\mongo`. It is fetched once (about 28 MB) by `tools\fetch-mongod.mjs`, and keeps
  running in the background after the app window is closed.

## How links work

| Link | Looks like | Who can copy it | Opening it |
| --- | --- | --- | --- |
| Direct | `/dl/<token>` | Master only | Download starts immediately |
| Protected | `/get/<token>` | Master and helper | Asks for the download password, then downloads |

Every client has an **always-latest** pair of links (the big buttons on the client page) that serve
whichever version is current, and every version has its own pair that never changes target.

- Uploading a version makes it current. **Make current** on an older version rolls back.
- **Archive** withdraws a version's links but keeps the file; it can be restored.
- **Reset links** replaces a link that was shared with the wrong person.
- The download password is set by the master under Settings. One password covers all protected links.

The server never sends a direct link to the helper account, so it cannot be recovered from the browser.

## Publish script

`tools\publish-router.bat` builds a router with the same steps as that project's `build.bat`, then
uploads the installer to the client's page.

1. In the app: **Settings > Publish script > Create Token**.
2. Save the config it shows as `tools\publish.config.json`.
3. Run it:

```
tools\publish-router.bat "D:\work\Go exe\KENYA" -Client "Kenya"
tools\publish-router.bat "D:\work\Go exe\GANESHAM" -Notes "API failover fix"
tools\publish-router.bat "D:\work\Go exe\RADX1" -SkipBuild
```

| Option | Meaning |
| --- | --- |
| folder | Router project to build. Defaults to the current folder. |
| `-Client` | Client name on the hub, created if new. Defaults to `productName` in `package.json`. |
| `-Version` | Defaults to `version` in `package.json`. |
| `-Notes` | What changed. |
| `-SkipBuild` | Upload the newest installer already in `dist\`. |
| `-File` | Upload one specific file. |
| `-Force` | Store the file even if an identical one is already there. |

`build.bat` is only read: the Go output name, package path, toolchain and electron-builder arguments
come from it, so the script follows each client's own settings. It deletes nothing. Where `build.bat`
wipes `dist\` to stop a stale installer shipping, this script instead refuses to upload any installer
that was not written during the current run.

## Deploying with GitHub Actions

Every push to `main` builds a container image, pushes it to GitHub's registry (ghcr.io) and switches
the server to it. There is no test stage. The gate is the stack's health check: a release that does
not come up healthy is replaced by the image that was running before, and the run is marked failed.

The server runs the app and MongoDB as containers (`deploy/docker-compose.yml`), plus Caddy in front
for HTTPS when a domain is configured. Before changing anything, each run checks that the ports it
needs are not held by another program on the server, so it never collides with other sites there. The database is not reachable from outside. Installers and the database live in Docker
volumes (`routerhub_storage`, `routerhub_mongo-data`), so they survive every deployment.

### Server, once

A Linux server reachable over SSH with a password, and ports 80 and 443 open. If the SSH user is
`root`, the first deployment installs Docker by itself. Any other user needs Docker installed once
by root and membership of the `docker` group:

```
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker <user>
```

### GitHub secrets

Repository > Settings > Secrets and variables > Actions > New repository secret.

| Secret | Required | Value |
| --- | --- | --- |
| `SSH_HOST` | yes | Server IP address or hostname |
| `SSH_USER` | yes | SSH username, for example `root` |
| `SSH_PASSWORD` | yes | That user's SSH password |
| `DOMAIN` | no | For example `routers.example.com`. Turns on HTTPS with automatic certificates; needs ports 80 and 443 free and the domain's DNS pointing at the server. Without it the app is served over plain HTTP at `http://<server>:8080`. |
| `HTTP_PORT` | no | Without a domain, the port the app is served on (default `8080`) |
| `SSH_PORT` | no | Only if SSH is not on port 22 |
| `SSH_KNOWN_HOSTS` | no | Output of `ssh-keyscan <server>`. Pins the server's identity; without it the key is accepted as found on each run. |

Registry access needs no secret: the workflow uses the token GitHub gives each run.

### Sign-in accounts

The master and helper accounts are created on the first start from `deploy/accounts.env`, which holds
only scrypt hashes, never the passwords. That file is read once, while the database is empty: after
the first deployment change passwords in the app under Settings, because editing the file no longer
has any effect. To choose different passwords before the first deployment, the file explains how to
generate a replacement hash.

### Using it

- **Deploy:** push to `main`.
- **Roll back:** Actions > Deploy > Run workflow, and enter the image tag of the release to return to
  (each run's summary shows its tag, such as `sha-1a2b3c4`).
- **Publish script:** point `tools\publish.config.json` at the server's address and a deploy token created there.

Old images are not removed from the server automatically. They share their base layers, so each
release adds little, but they do accumulate.

Direct links have no password, so set `DOMAIN` to serve over HTTPS and treat those links as secrets.
Back up the two volumes together.

### Without containers

Copy the folder, run `npm run setup`, then set in `.env`:

```
PUBLIC_BASE_URL=https://routers.example.com   # the address people will open links on
SECURE_COOKIES=true                           # when served over HTTPS
TRUST_PROXY=1                                 # when behind nginx, Caddy or IIS
```

Uploaded installers then live in `storage\<client>\`.

## Layout

```
server\   Express API, MongoDB access, download and link handling
web\      React interface (built into web\dist, served by the server)
tools\    start.mjs, fetch-mongod.mjs, publish-router.bat / .ps1
deploy\   production stack: docker-compose.yml, Caddyfile, deploy.sh
.github\  the Deploy workflow
Dockerfile
storage\  uploaded installers        (created at runtime)
.data\    bundled MongoDB data files  (created at runtime)
```
