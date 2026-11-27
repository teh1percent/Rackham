# Rackham

<img src="public/logo.svg" alt="Rackham logo" width="96">

Pick your media apps in a browser, enter your settings once, and get a running,
connected stack: the wizard writes the Docker Compose file, starts the apps, then
uses each app's API to wire them together.

## Status

Version 0.1. Deploy and auto-configure have been run for real on a Fedora
CoreOS based host with SELinux enforcing, under both root and rootless Docker,
for Sonarr, Radarr, Prowlarr (with indexers), SABnzbd (with a usenet server)
and Jellyfin. Tracearr, Seerr and Wizarr have been deployed and start.

**Not yet run against real containers:** Plex claim and libraries, and Tautulli.

On SELinux hosts the wizard turns container labelling off for apps that mount
host folders (`security_opt: label=disable`), and the setup container itself
needs `--security-opt label=disable` to reach the Docker socket.

## What gets set up for you

| App | Automatic | Left for you |
|---|---|---|
| Sonarr, Radarr | API key, library folder, SABnzbd as download client, login | - |
| Prowlarr | API key, linked to Sonarr and Radarr, Newznab indexers, login | - |
| SABnzbd | API key, folders, categories, usenet server, login | - |
| Jellyfin | First-run screens, admin user, Movies and Shows libraries | - |
| Plex | Claimed with your claim token, Movies and TV Shows libraries | Sign-in if no token given |
| Tautulli, Tracearr, Seerr, Wizarr | Started (Tracearr with its database, cache and secrets) | Sign-in and connection (the wizard shows the values to paste) |

## Run it on the server (recommended)

The quickest way is the included `compose.yaml`, which uses the published image
`ghcr.io/teh1percent/rackham:latest`. Save that one file on the server and run:

```bash
docker compose up -d
```

Then open `http://<server>:8099`. The stack is written to `/opt/rackham` unless
you set `STACK_DIR`. Stop Rackham with `docker compose down` when you're done.

### Without the compose file

Build the image, then start it with the Docker socket and a stack folder. The
stack folder **must be mounted at the same path inside the container as on the
host**, because the compose file it writes uses paths the host has to understand.

```bash
docker build -t rackham .
```

```bash
docker run --rm -p 8099:8099 -v /var/run/docker.sock:/var/run/docker.sock -v /opt/media-stack:/opt/media-stack -e STACK_DIR=/opt/media-stack rackham
```

Open `http://<server>:8099`. Use an absolute path for the media and downloads folder.

## Run it without a container

Needs Node 20+ and Docker on the same machine.

```bash
npm start
```

Files are written to `./stack` unless `STACK_DIR` is set.

## Safety

- The setup app has no login and controls Docker. Run it only on a network you
  trust, and stop it when setup is finished.
- Passwords you type are held in memory for the deploy and written only where an
  app needs them (`sabnzbd.ini`). API keys are written to `.env`.
- Existing app settings are never overwritten; existing API keys are reused.

## Tests

```bash
npm test
```
