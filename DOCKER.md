# Run the URL shortener with Docker Compose

Open a terminal in the project root with Docker Desktop running.

```powershell
docker compose up -d --build
```

Compose builds the application image and starts the whole application. The first run downloads missing images and initializes MySQL. Later runs reuse the database and queue volumes.

## Share through Docker Hub and GitHub

The custom image names in `compose.yaml` are `bharatgwl/url-shortener-app:latest` and `bharatgwl/url-shortener-nginx:latest`. Create matching public repositories in the `bharatgwl` Docker Hub account, then publish from the project root.

```powershell
docker login
docker compose build creation-1 nginx
docker compose push creation-1 nginx
```

`creation-1` builds the shared Node.js image used by both creation instances, both redirect instances, both workers and queue initialization. `nginx` builds the proxy image. The Redis and MySQL services use their official images.

Push the source code, Dockerfiles, `compose.yaml`, `nginx/compose.conf`, `docker/init-queue.js`, `docker/export-data.js`, `docker/mysql/01-schema.sql`, `.dockerignore`, `.gitignore`, and documentation to GitHub. The repository's ignore rules exclude the local `.env`, dependencies, migration SQL and migration report.

After both images have been published and the updated files pushed to GitHub, another developer can clone the repository and run the prebuilt images.

```powershell
git clone https://github.com/Bharatgwl/Url_shortner.git
cd Url_shortner
docker compose pull
docker compose up -d --no-build
```

Open `http://localhost:8080`. A fresh installation creates its own database schema, stream and consumer group. The migration snapshot stays local to the original installation. Public image availability depends on completing the publish commands above.

## Services

| Service | Work | Host access |
| --- | --- | --- |
| nginx | Routes requests and balances each HTTP service group | http://localhost:8080 |
| creation-1 / creation-2 | Create links, internal ports 8000 / 8002 | Through Nginx |
| redirect-1 / redirect-2 | Redirect and stats routes, internal ports 8001 / 8003 | Through Nginx |
| worker-1 / worker-2 | Save click events and acknowledge them | Docker logs |
| mysql | URL mappings and recorded click events | 127.0.0.1:3307 |
| cache | Cached URL mappings | 127.0.0.1:6379 |
| queue | Click stream, consumer group, retries and failed stream | 127.0.0.1:6380 |
| queue-init | Creates analytics:clicks and click-workers when needed | Exits successfully after setup |

There are ten continuously running containers and one setup container. `queue-init` showing `Exited (0)` is expected. Consumers are registered as each worker starts reading.

MySQL and Redis have health checks. The app instances wait for MySQL. Redirects and workers also wait for queue setup. Nginx waits for all four app instances to respond to `/health`. Dependency checks control initial startup. The existing cache fallback, bounded publishing and worker retries handle runtime failures.

Inside Docker, services connect using names such as `mysql:3306` and `queue:6379`. The public address remains `http://localhost:8080`. Container environment values are defined in `compose.yaml`; the local `.env` continues to supply the manual host workflow and the one-time data exporter.

## Check and operate the application

```powershell
docker compose ps -a
docker compose logs -f
```

Follow only the workers or HTTP services when needed.

```powershell
docker compose logs -f worker-1 worker-2
docker compose logs -f creation-1 creation-2 redirect-1 redirect-2
```

Run Redis CLI inside the queue container.

```powershell
docker compose exec queue redis-cli
```

Then use the same Redis commands you learned.

```redis
XLEN analytics:clicks
XPENDING analytics:clicks click-workers
XLEN analytics:clicks:failed
```

Open Redis Insight and connect to `127.0.0.1:6380` for the queue or `127.0.0.1:6379` for the cache. Connect MySQL Workbench to `127.0.0.1:3307`, user `shortener`, database `url_shortner`. The local development password defaults are in `compose.yaml`.

Stop and start the Compose application together.

```powershell
docker compose stop
docker compose up -d
```

To remove the Compose containers and network while retaining the named data volumes, run `docker compose down`. The `-v` option also removes named volumes and erases that Compose data. Source edits require `docker compose up -d --build` to rebuild the images.

The fixed Compose project name and explicit data volume names preserve the same data across folder renames. Paths in `compose.yaml` are relative to the project. After moving the folder, open its new root and run `docker compose up -d --build` so Compose recreates any path-dependent mount.

## Existing-data migration

The initial migration uses a consistent read-only snapshot of the local MySQL `links` and `click_events` tables. `docker/export-data.js` reads connection details from the existing root `.env` and writes `docker/mysql/20-existing-data.sql`. UTC export preserves original TIMESTAMP values and fractional seconds.

On an empty MySQL data volume, the official image executes `01-schema.sql` and then `20-existing-data.sql`. Subsequent startups keep the existing data directory. MySQL initialization scripts run only when that directory is empty, so editing the snapshot later does not reimport it.

The export SQL and `docker/migration-report.json` contain private data or migration metadata and are Git-ignored. The SQL is excluded from Docker image builds and mounted only into MySQL's initialization directory. Keep the snapshot as a migration backup.

For a future first-time migration from a different host installation, run the exporter once before the first Compose startup.

```powershell
node .\docker\export-data.js
docker compose up -d --build
```

The exporter refuses to overwrite an existing snapshot. Archive an old export before intentionally creating another one. A fresh clone can initialize an empty schema without a snapshot.

The queue migration copies the stopped original queue's data volume into `url-shortener-compose-queue-data` before the first Compose startup. This preserves stream contents, group position, pending ownership and failure counters together. The Compose queue continues using AOF. MySQL uses `url-shortener-compose-mysql-data`. These are the Docker setup's persistent volumes.

For a future first-time queue migration, stop the old queue with `docker stop url-shortener-queue` and keep its `url-shortener-queue-data` volume. With an empty destination, create the new queue container and copy the files before starting it.

```powershell
docker compose create queue
docker run --rm --network none --mount type=volume,source=url-shortener-queue-data,target=/source,readonly --mount type=volume,source=url-shortener-compose-queue-data,target=/target redis:7-alpine cp -a /source/. /target/
```

That copy is a one-time migration into an empty destination. Run it before the first `docker compose up`, while the original queue is stopped. The migration for this project has already been performed.

Start the Compose deployment after finishing the old manual run so the same host ports are available. Continue future work against the Compose database and queue. The old manual services and Compose services have separate data after migration.

Optional settings for this new Compose deployment use the `DOCKER_` prefix. Defaults are HTTP 8080, MySQL 3307, cache 6379, queue 6380, and the local development database passwords shown in YAML. MySQL initialization applies its credential values when creating an empty data volume. Choose different credentials before first initialization if needed.

## Health and requests

```powershell
curl.exe -i http://localhost:8080/health
```

Expect HTTP 200. To create a link from PowerShell, run the following and then open the returned short URL.

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8080/links -ContentType 'application/json' -Body '{"original_url":"https://example.com/"}'
```

Use `/links/YOUR_CODE/stats` to check its saved click count after a worker processes the event.

## Verified on 20 November 2026

| Check | Result |
| --- | --- |
| Original MySQL migration | 52 links and 177 click events; every row matched the source snapshot hashes, including timestamps |
| Queue migration | 176 click-stream entries, 1 failed-stream entry, 2 consumers, 0 pending |
| Build and startup | Node.js 26.13.1 image and Nginx image built; all 10 long-running containers started; queue-init exited 0 |
| Routing | Four POST requests returned 201 across both creation instances; four redirects returned 302 across both redirect instances |
| Cache and workers | Cache HIT observed; both workers processed events; recorded count reached 4; pending returned to 0 |
| Errors | HTTP URL returned 400; missing short code and missing stats returned 404 |
| Complete stop/start | Saved test link, click count and failed stream survived; existing group setup succeeded again |
| Cleanup | Verification links and events removed; original 52/177 MySQL rows matched the snapshot again; queue returned to 176 entries and 1 failed event |

These checks covered local Compose startup and request behavior. Worker containers showed running status and successful event processing. The `/health` endpoints report HTTP responsiveness.

Sources cover [Compose startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [service networking](https://docs.docker.com/compose/how-tos/networking/), and [MySQL image initialization](https://hub.docker.com/_/mysql).
