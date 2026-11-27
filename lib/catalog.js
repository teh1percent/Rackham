// Every app the wizard can deploy. `auto` describes how much of the setup the
// wizard finishes on its own: "full", "partial" (needs one manual sign-in) or "manual".

const lsio = { PUID: '${PUID}', PGID: '${PGID}', TZ: '${TZ}' };

export const SERVICES = [
  {
    id: 'plex', name: 'Plex', group: 'Watch', port: 32400, auto: 'partial',
    blurb: 'Stream your library to any device',
    image: 'lscr.io/linuxserver/plex:latest',
    environment: { ...lsio, VERSION: 'docker', PLEX_CLAIM: '${PLEX_CLAIM:-}' },
    volumes: ['./config/plex:/config', '${DATA_ROOT}/media:/data/media'],
  },
  {
    id: 'jellyfin', name: 'Jellyfin', group: 'Watch', port: 8096, auto: 'full',
    blurb: 'Free, open-source media server',
    image: 'lscr.io/linuxserver/jellyfin:latest',
    environment: { ...lsio },
    volumes: ['./config/jellyfin:/config', '${DATA_ROOT}/media:/data/media'],
  },
  {
    id: 'tautulli', name: 'Tautulli', group: 'Metrics', port: 8181, auto: 'manual',
    blurb: 'Watch history and stats for Plex',
    requires: ['plex'],
    image: 'lscr.io/linuxserver/tautulli:latest',
    environment: { ...lsio },
    volumes: ['./config/tautulli:/config'],
    depends_on: ['plex'],
  },
  {
    // Standard (three-container) layout from Tracearr's own quick start:
    // docker/examples/docker-compose.pg18.yml in connorgallopo/Tracearr.
    id: 'tracearr', name: 'Tracearr', group: 'Metrics', port: 3000, auto: 'manual',
    blurb: 'Live streams and stats for Plex and Jellyfin',
    requiresAny: ['plex', 'jellyfin'],
    image: 'ghcr.io/connorgallopo/tracearr:latest',
    environment: {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      TZ: '${TZ}',
      DATABASE_URL: 'postgres://tracearr:${TRACEARR_DB_PASSWORD}@tracearr-db:5432/tracearr',
      REDIS_URL: 'redis://tracearr-redis:6379',
      JWT_SECRET: '${TRACEARR_JWT_SECRET}',
      COOKIE_SECRET: '${TRACEARR_COOKIE_SECRET}',
      CORS_ORIGIN: '*',
      LOG_LEVEL: 'info',
    },
    volumes: ['tracearr_backups:/data/backup', 'tracearr_images:/data/tracearr/image-cache'],
    depends_on: {
      'tracearr-db': { condition: 'service_healthy' },
      'tracearr-redis': { condition: 'service_healthy' },
    },
    namedVolumes: ['tracearr_backups', 'tracearr_images', 'tracearr_db', 'tracearr_redis'],
    // Extra containers Tracearr needs; they have no web page of their own.
    sidecars: {
      'tracearr-db': {
        image: 'timescale/timescaledb-ha:pg18.4-ts2.29.1',
        shm_size: '512mb',
        ulimits: { nofile: { soft: 65536, hard: 65536 } },
        command: 'postgres -c timescaledb.license=timescale -c timescaledb.max_tuples_decompressed_per_dml_transaction=100000 -c max_locks_per_transaction=4096 -c timescaledb.telemetry_level=off -c max_connections=150',
        environment: { POSTGRES_USER: 'tracearr', POSTGRES_PASSWORD: '${TRACEARR_DB_PASSWORD}', POSTGRES_DB: 'tracearr' },
        volumes: ['tracearr_db:/home/postgres/pgdata/data'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U tracearr'], interval: '10s', timeout: '5s', retries: 5 },
      },
      'tracearr-redis': {
        image: 'redis:8-alpine',
        command: 'redis-server --appendonly yes',
        volumes: ['tracearr_redis:/data'],
        healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '10s', timeout: '5s', retries: 5 },
      },
    },
  },
  {
    id: 'sonarr', name: 'Sonarr', group: 'Automate', port: 8989, auto: 'full',
    blurb: 'Finds and organises TV shows',
    image: 'lscr.io/linuxserver/sonarr:latest',
    environment: { ...lsio, SONARR__AUTH__APIKEY: '${SONARR_API_KEY}' },
    volumes: ['./config/sonarr:/config', '${DATA_ROOT}:/data'],
  },
  {
    id: 'radarr', name: 'Radarr', group: 'Automate', port: 7878, auto: 'full',
    blurb: 'Finds and organises movies',
    image: 'lscr.io/linuxserver/radarr:latest',
    environment: { ...lsio, RADARR__AUTH__APIKEY: '${RADARR_API_KEY}' },
    volumes: ['./config/radarr:/config', '${DATA_ROOT}:/data'],
  },
  {
    id: 'prowlarr', name: 'Prowlarr', group: 'Automate', port: 9696, auto: 'full',
    blurb: 'One place for all your indexers',
    image: 'lscr.io/linuxserver/prowlarr:latest',
    environment: { ...lsio, PROWLARR__AUTH__APIKEY: '${PROWLARR_API_KEY}' },
    volumes: ['./config/prowlarr:/config'],
  },
  {
    id: 'sabnzbd', name: 'SABnzbd', group: 'Automate', port: 8080, auto: 'full',
    blurb: 'Usenet downloader',
    image: 'lscr.io/linuxserver/sabnzbd:latest',
    environment: { ...lsio },
    volumes: ['./config/sabnzbd:/config', '${DATA_ROOT}/usenet:/data/usenet'],
  },
  {
    id: 'seerr', name: 'Seerr', group: 'Share', port: 5055, auto: 'manual',
    blurb: 'Lets friends request movies and shows',
    requiresAny: ['plex', 'jellyfin'],
    image: 'ghcr.io/seerr-team/seerr:latest',
    init: true,
    environment: { TZ: '${TZ}', LOG_LEVEL: 'info' },
    volumes: ['./config/seerr:/app/config'],
    healthcheck: {
      test: 'wget --no-verbose --tries=1 --spider http://localhost:5055/api/v1/status || exit 1',
      start_period: '20s', timeout: '3s', interval: '15s', retries: 3,
    },
  },
  {
    id: 'wizarr', name: 'Wizarr', group: 'Share', port: 5690, auto: 'manual',
    blurb: 'Invite links for new users',
    requiresAny: ['plex', 'jellyfin'],
    image: 'ghcr.io/wizarrrr/wizarr:latest',
    environment: { ...lsio },
    volumes: ['./config/wizarr/database:/data/database', './config/wizarr/wizard_steps:/data/wizard_steps'],
  },
];

export const byId = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

// What the browser needs to draw the picker.
export function publicCatalog() {
  return SERVICES.map(({ id, name, group, port, auto, blurb, requires, requiresAny }) => ({
    id, name, group, port, auto, blurb, requires: requires || [], requiresAny: requiresAny || [],
  }));
}
