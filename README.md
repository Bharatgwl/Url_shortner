# URL Shortener

A learning project built with Node.js, Express, MySQL, and Redis. It creates short links for HTTPS URLs and redirects visitors to the saved destination.

**Current stage: Version 6 complete for the agreed learning milestone - creation and redirect services run separately, with Nginx path routing and independent failure/recovery verified locally.** These are learning milestones; the npm package version is still `1.0.0`.

## Version stages

| Stage | Status | What was built |
| --- | --- | --- |
| Version 1: working URL shortener | Complete | HTTP server, HTTPS validation, MySQL mappings, six-character case-sensitive codes, collision retries, redirects, and basic error handling |
| Version 2: layered application | Complete | Separate routes, business logic, SQL queries, and connection configuration into modules |
| Version 3: Redis cache and resilience | Complete | Cache-aside, TTL, MySQL fallback, optional Redis startup, reconnection, 500 ms waiting deadline, five-second cooldown, and queue limit |
| Version 4: multiple instances and load balancing | Complete | Two host Node.js processes on ports 8000/8001 behind Docker Nginx on 8080; shared MySQL/Redis; distribution, failover, and recovery verified locally |
| Version 5: background analytics | Complete; local tests passed | Redis Streams analytics, two workers, event-ID deduplication, retries and failed stream, idle pending recovery, stats API, shortcode index, and a manual replay verification |
| Version 6: creation/redirect separation | Complete; local tests passed | Creation on 8000, redirects/stats on 8001, Nginx path routing on 8080, and independent failure/recovery checks |

See [Design.md](Design.md) for design decisions and verified results, and [CACHING.md](CACHING.md) for caching concepts and limitations.

See [SCALING.md](SCALING.md) for Version 4 concepts, request flow, and failover limitations.

## Features

- Six-character random codes using uppercase letters, lowercase letters, and digits.
- Case-sensitive codes: `ntGn2e` and `ntGn2E` are different.
- Persistent URL mappings in MySQL.
- Up to five insert attempts when generated codes collide.
- HTTPS destination validation and parameterized database queries.
- A new short link for every submission; existing links keep working.
- Shared Redis cache-aside lookup with a 300-second TTL.
- MySQL fallback when Redis is unavailable, fails, or takes too long.
- A 500 ms application waiting deadline per cache operation and a five-second failure cooldown.
- A Redis client queue limit of 100 with offline queueing disabled.
- Background Redis reconnection; the server can start without Redis when MySQL is available.
- Click events published for known short links, including cache hits.
- A separate Redis queue on port 6380; cache Redis remains on 6379.
- A 500 ms waiting deadline for publishing; publish failures are logged and the redirect continues.
- Background workers in one consumer group, with MySQL event-ID deduplication and ACK after saving.
- Three recorded save failures before transfer to a failed-event stream.
- Recovery of idle pending events through XAUTOCLAIM, using a 60-second idle threshold.
- A stats API returning the recorded click count, supported by a shortcode index.
- Separate creation and redirect processes, selected by Nginx request-path routing.

## Current architecture

Nginx in Docker exposes `http://localhost:8080`. The exact path `/links` goes to the creation service on host port 8000; other paths go to the redirect service on 8001, including `/links/:code/stats`. Both services use the same MySQL database. The redirect service also connects to cache Redis and queue Redis; analytics workers consume queue events into MySQL.

```text
Client -> Nginx :8080
            /links       -> Creation :8000 -> MySQL links
            other paths  -> Redirect :8001 -> Redis cache / MySQL links
                                stats     -> MySQL click_events
                                clicks    -> Redis queue :6380
                                             -> worker-1 / worker-2 -> MySQL click_events
```

```text
creationServer.js
redirectServer.js
routes/creationRoutes.js
routes/redirectRoutes.js
services/linkServices.js
repositories/linkRepository.js
config/db.js
config/redis.js
config/queueRedis.js
queues/clickQueue.js
queues/clickRetries.js
queues/failedClickQueue.js
repositories/clickRepository.js
workers/clickWorker.js
utils/withTimeout.js
nginx/nginx.conf
```

These are two services with different route responsibilities. They share one repository, service modules, and MySQL database; all components still run on one computer. `server.js` and `routes/linkRoutes.js` remain as the older combined entry point and router. V6 startup uses the two new entry points below.

## Requirements

- Node.js with ES module and top-level await support, and npm.
- A running MySQL server; MySQL Workbench is optional.
- Docker Desktop for Nginx and the two Redis containers. Cache and queue Redis are optional for serving redirects, but required to exercise their respective features.
- Globally installed nodemon if using `npm run dev`.

## Setup

### 1. Install dependencies

Open a terminal in the project folder and run:

```sh
npm install
```

### 2. Set up MySQL

For a fresh database, run the following in MySQL Workbench or another SQL client. If your database and table already exist, skip this step.

```sql
CREATE DATABASE url_shortner;
USE url_shortner;

CREATE TABLE links (
    shortcode VARCHAR(6) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (shortcode)
);
```

The primary key prevents duplicate codes. The `ascii_bin` collation makes code comparisons case-sensitive. The application generates exactly six characters; `VARCHAR(6)` itself sets only a maximum length.

### 3. Configure environment variables

Create `.env` in the project root. Replace the placeholder credentials with your local MySQL details:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_mysql_user
DB_PASSWORD="your_mysql_password"
DB_NAME=url_shortner
BASE_URL=http://localhost:8080
REDIS_URL=redis://127.0.0.1:6379
QUEUE_REDIS_URL=redis://127.0.0.1:6380
```

Use no trailing slash in `BASE_URL`. It controls returned links, not the listening port. Set `PORT` separately in each terminal as shown below. Creation defaults to 8000 and redirect defaults to 8001; an existing PORT environment variable overrides either default. The legacy combined server.js defaults to 8888.

Keep `.env` and `node_modules/` in `.gitignore`. Never commit actual credentials.

### 4. Start Redis

For the first run, start Docker Desktop and create the container:

```powershell
docker run -d --name url-shortener-redis -p 127.0.0.1:6379:6379 redis:7-alpine
docker exec url-shortener-redis redis-cli ping
```

Expected reply: `PONG`. Docker downloads the image if it is not already present. For later runs, reuse the existing container:

```powershell
docker start url-shortener-redis
```

The port binding exposes cache Redis only on the local machine. Cache data is disposable; MySQL remains the source of truth for URL mappings.

### 5. Start the creation and redirect services

From the project root, open two PowerShell terminals. In terminal 1:

```powershell
$env:PORT="8000"
node creationServer.js
```

In terminal 2:

```powershell
$env:PORT="8001"
node redirectServer.js
```

Each terminal must show its service name and assigned port. Node does not reload edits automatically; restart the affected process after source edits. With globally installed nodemon, use `nodemon creationServer.js` or `nodemon redirectServer.js` in the corresponding terminal. The existing `npm run dev` script still starts the legacy combined server.js; it is not the V6 startup command.

Each service checks MySQL before listening. Only the redirect entry point connects cache and queue Redis in the background, so Redis ready messages may appear before or after its listening message. For example:

```text
Database connected
Redirect Server listening on 8001
Redis ready: caching available
```

If Redis is down, connection errors and reconnect attempts are logged, but MySQL-backed requests can still be served. If the initial MySQL check fails, the server does not start listening.

### 6. Start Nginx

From the project root in another PowerShell terminal, create the container once:

```powershell
docker run -d --name url-shortener-nginx -p 127.0.0.1:8080:80 --mount "type=bind,source=$($PWD.Path)\nginx\nginx.conf,target=/etc/nginx/nginx.conf,readonly" nginx:stable-alpine
```

For later runs, use `docker start url-shortener-nginx`. Nginx reaches the host applications through `host.docker.internal:8000` and `:8001`. The mounted config is `nginx/nginx.conf`.

Check each service directly at `http://localhost:8000/health` and `http://localhost:8001/health`. Through 8080, `/health` is routed only to the redirect service; it does not represent both services. Both terminals log handled requests. Generated links continue to use 8080.

The mounted config has separate creation_service and redirect_service upstreams. `location = /links` matches the exact path; `location /` forwards remaining paths to redirect. It is path routing, not round-robin between different service roles. Each service's Express router handles HTTP methods. `/links/` does not match the exact creation location; use the documented `/links` path. After editing the config, validate with `docker exec url-shortener-nginx nginx -t` and, on success, apply it with `docker exec url-shortener-nginx nginx -s reload`.

### 7. Set up the analytics queue and workers

For a fresh installation, create the click table in `url_shortner`. Skip this SQL when the table already exists. The current click table allows up to 36 characters for `shortcode`; generated link codes remain six characters.

```sql
CREATE TABLE click_events (
    event_id VARCHAR(36) NOT NULL,
    shortcode VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    PRIMARY KEY (event_id),
    KEY idx_click_events_shortcode (shortcode)
);
```

For an existing click table, check `SHOW INDEX FROM click_events` first. If the shortcode index is missing, the migration used in this milestone is:

```sql
CREATE INDEX idx_click_events_shortcode ON click_events (shortcode);
```

Create the queue container once, with AOF and a named data volume:

```powershell
docker run -d --name url-shortener-queue -p 127.0.0.1:6380:6379 -v url-shortener-queue-data:/data redis:7-alpine redis-server --appendonly yes
docker exec url-shortener-queue redis-cli PING
docker exec url-shortener-queue redis-cli XGROUP CREATE analytics:clicks click-workers 0 MKSTREAM
```

`MKSTREAM` creates the stream if needed. `BUSYGROUP` means this group already exists; do not recreate it. Group creation is a one-time manual setup step, not part of worker startup. For later runs use `docker start url-shortener-queue`. Persistence reduces restart data loss; it does not guarantee that every acknowledged Redis write survives a machine failure.

Run the same worker file in two separate terminals from the project root:

```powershell
node .\workers\clickWorker.js worker-1
```

```powershell
node .\workers\clickWorker.js worker-2
```

Each simultaneously running worker needs its own consumer name. Without an argument, the file defaults to `worker-1`. Both use the `click-workers` group on `analytics:clicks`. Group distribution is not guaranteed to be 50/50. Restart worker processes after editing their source; `node` does not automatically reload it.

## API

### Health check

`GET /health`

Returns `200 OK` with the text `OK`. This checks that the HTTP server responds; it does not perform a new database check.

### Create a short link

`POST /links`

Send JSON with the header `Content-Type: application/json`:

```json
{
  "original_url": "https://example.com/articles/introduction-to-system-design"
}
```

Example response: `201 Created`.

```json
{
  "short_url": "http://localhost:8080/abc123"
}
```

The code is generated randomly, so your response will differ.

| Status | Meaning |
| --- | --- |
| 201 | Mapping saved and short URL returned. |
| 400 | Missing, empty, non-string, invalid, or non-HTTPS destination. |
| 500 | Database operation failed or all five code attempts collided. |

The server stores the parsed URL's `href`. It validates URL structure and HTTPS usage; it does not check whether the destination is reachable or trustworthy.

### Open a short link

`GET /:code`

Example: `GET /abc123`.

| Status | Meaning |
| --- | --- |
| 302 | Original URL returned in the `Location` header; the browser follows it. |
| 404 | No mapping exists for that code. |
| 500 | Database lookup failed. |

`/health` is a reserved route. The application server must be running for short links to redirect.

### Read recorded click statistics

`GET /links/:code/stats`

```json
{
  "shortcode": "NJ75eh",
  "total_clicks": 48
}
```

The example count is illustrative. Existing links return 200 with a numeric count, including zero for a link with no recorded clicks. Unknown codes return 404; database errors return 500. Codes are case-sensitive. Stats requests do not publish click events. Because analytics is processed in the background, the latest click can appear after a delay; the count represents saved events, not guaranteed unique visitors or every attempted redirect.

The service first checks the link mapping, then counts matching click_events rows using a parameterized query. The B-tree index on shortcode supports that query; the count still examines matching index entries and is not a precomputed constant-time total.

## Request flows

**Create:** client sends URL -> server validates -> generates code -> inserts mapping -> returns short URL. A duplicate code triggers another attempt, up to five total attempts.

**Open:** browser sends code -> service resolves the destination through cache/MySQL -> unknown code returns 404 -> a found destination triggers a bounded attempt to publish a click event -> route returns 302 -> browser requests the destination website. A cache hit skips MySQL mapping lookup but still publishes a click event.

**Analytics:** Redis stream -> consumer worker -> MySQL click_events -> ACK -> clear the failure counter. The HTTP route waits for the queue publish attempt, up to its 500 ms deadline, but does not wait for the worker or click-table insert. Queue publish errors still allow the redirect.

Redis lookup failures use MySQL directly and start a five-second cooldown. Cache-write failures still return the URL found in MySQL. Unknown mappings are not cached. See [CACHING.md](CACHING.md) for the full failure flow.

## Manual verification

Use Thunder Client in VS Code for POST requests and a browser for redirects.

- Create a link for a valid HTTPS URL: expect 201 and a saved database row.
- Open the returned link: expect a redirect to the destination.
- Submit HTTP URLs, random text, empty input, and a missing field: expect 400.
- Request an unknown code: expect 404.
- Submit the same destination twice: expect different short links that both work.
- Change the case of a code: expect 404 unless that exact other code exists.
- Restart the server and open a saved link: it should still work.
- Temporarily force an existing code for all five attempts: expect 500 and no overwritten mapping.
- Temporarily generate an existing code followed by an unused code: expect 201 with the unused code.

Restore normal random generation after collision testing. There is currently no automated test suite; `npm test` is the default placeholder and exits with an error.

### Cache checks and verified results

Use an actual generated code in the commands below:

```powershell
docker exec url-shortener-redis redis-cli GET url:YOUR_CODE
docker exec url-shortener-redis redis-cli TTL url:YOUR_CODE
```

A positive TTL is the remaining lifetime in seconds. `-2` means the key is missing; `-1` means it exists without an expiry.

For HTTP timing on Windows, replace `YOUR_CODE` with a saved code. Do not add `-L`, which would follow the redirect:

```powershell
curl.exe --max-time 5 -sS -o NUL -w "Status: %{http_code} | Time: %{time_total}s\n" http://localhost:8080/YOUR_CODE
```

| Verified scenario | Observed result |
| --- | --- |
| Small local timing samples | Before cache: 3.35 ms average; after cache: 2.96 ms average; not enough evidence for a reliable speedup |
| Redis stopped or unavailable at startup | Redirects continued through MySQL |
| Redis paused, first request | 302 in approximately 503 ms through timeout fallback |
| Immediate second request while paused | 302 in approximately 2.39 ms during cooldown |
| Recovery after cooldown | Fresh Cache HIT logs observed |
| Queue saturation: actual service test | 20 queue-full errors and 100 waiting timeouts; all 120 lookups returned a URL |
| Queue saturation: live HTTP test | All 120 concurrent requests returned 302 while Redis was paused |

These are local learning tests, not production capacity guarantees. For outage tests, always restart or unpause Redis afterward. The 120-request test script, if retained as `queue-test.js`, is a manual load helper, not a replacement for assertions or an automated test suite.

### Analytics checks and verified results

```powershell
docker exec url-shortener-queue redis-cli XREVRANGE analytics:clicks + - COUNT 1
docker exec url-shortener-queue redis-cli XPENDING analytics:clicks click-workers
docker exec url-shortener-queue redis-cli XREVRANGE analytics:clicks:failed + - COUNT 1
```

Each click gets a new application `event_id` UUID. Retries reuse that UUID; the MySQL primary key prevents duplicate rows. Redis also assigns a separate stream entry ID used for ACK and pending ownership. ACK removes pending tracking, not the original stream entry. A pending count of zero alone does not prove successful analytics; check worker logs and MySQL too.

| Verified scenario | Observed result |
| --- | --- |
| Known-link redirect | 302 and a click event published; worker saved the event and ACKed |
| Duplicate save of one application event ID | One MySQL row; duplicate handling allowed processing to finish |
| Queue Redis unavailable | User observed 302 redirects; worker reconnected after Redis returned and processed later events |
| Invalid oversized shortcode followed by a valid event | Agent observed exactly three save failures, one failed-stream entry with attempts=3, original ACK, cleared counters, zero test events pending, and one valid MySQL row; agent test data cleaned up |
| Two live consumers | User observed Event processed logs in both worker terminals |
| Event assigned to stopped worker-1 | User observed pending=1 owned by worker-1, then pending=0 after worker-2 ran; the recovered NJ75eh event was confirmed in MySQL |

See [Design.md](Design.md) for the worker decision flow, the manually created recovery fixture, and remaining delivery limitations. These checks are local observations; automated coverage is still limited.

### Stats, indexing, and manual replay results

| Check | Verified result |
| --- | --- |
| Existing link stats | User received NJ75eh with numeric total_clicks=48 |
| Repeated stats read, then one redirect | User confirmed stable count for stats-only reads and an increment after worker processing |
| Unknown code | User confirmed 404 |
| New unvisited link | User confirmed total_clicks=0 for uEtffX; lowercase uEtffx correctly returned 404 |
| EXPLAIN before index | ALL, key=NULL, estimated rows=100, Using where |
| EXPLAIN after index | ref, idx_click_events_shortcode, estimated rows=50, Using index |
| Manual replay of corrected failed test event | Original UUID and timestamp preserved; worker saved one MySQL row and ACKed; replay pending=0, counter cleared, failed-stream original retained |

The EXPLAIN estimates do not prove a 2x speedup. The manual replay deliberately corrected an invalid test event to NJ75eh and added one synthetic click to that link's recorded count. No automatic replay service or general replay command was added.

### Version 6: verified routing and service failures

| Scenario | Expected and observed result | Evidence |
| --- | --- | --- |
| Direct health checks | Both 8000 and 8001 returned 200 | User pasted HTTP output |
| Direct creation and redirect | Creation POST returned 201; saved code redirected through 8001 with 302 | User confirmation and pasted redirect response |
| Route ownership | GET of a valid code on creation returned 404; POST /links on redirect returned 404; stats worked on redirect | User checks and confirmation |
| Full flow through Nginx | POST on 8080 reached creation; stats returned zero; redirect returned 302; worker processing increased recorded count | User confirmation |
| Creation stopped | Existing redirect stayed 302; creation POST returned 502; creation returned 201 after restart | User confirmation of the guided test |
| Redirect stopped | Creation POST stayed 201; redirects/stats returned 502; they recovered after redirect restarted | User confirmation of the guided test |
| Restart response clarification | Agent independently observed 302 through 8080 and directly on 8001, plus 200 stats | Curl requests without following redirects; the user's 403 was likely from the destination after redirect following |

Each role currently has one instance. These tests demonstrate independence of the HTTP service roles; they do not demonstrate replacement-instance failover or higher throughput. A real destination may reject the client after a successful shortener redirect. Verify the shortener's status without following redirects.

## Current limits and future work

This is a local learning setup with one creation process, one redirect process, two analytics worker processes, one Nginx container, one MySQL database, and separate Redis cache and queue containers on the same computer. A stopped role returns 502 for its routed requests; the other role can continue when shared dependencies are healthy. A machine failure still stops the entire setup. `localhost` links are not public shareable links.

The waiting deadline does not cancel underlying Redis commands. Cooldown state is per application process; simultaneous misses are not coalesced. Cache outages transfer traffic to MySQL. The queue limit is not an HTTP rate limit, and there is no overall HTTP request deadline.

Version 5 now includes background click analytics, retries, a failed stream, and pending recovery. Version 5 and the agreed Version 6 service-separation milestone are closed. Follow-up work includes replay tooling, stream retention, better failure classification, and a later Kafka migration. Failed-stream publishing and original ACK are separate operations, so a crash between them can create duplicate failed-stream entries. Queue outages can lose click events because redirects continue without a durable application outbox. A publishing timeout does not cancel an underlying Redis append, so its final outcome can be uncertain. The 60-second reclaim threshold is an idle-time rule, not proof that another worker crashed; slow live work can also be claimed.

Later work includes automated tests, deployment, rate limiting, abuse controls, URL expiry, and measured scaling. POST retry idempotency is not implemented. Cache TTL expires only the cached copy; URL mappings currently have no expiry. There are no user accounts, QR codes, or destination safety checks. Code generation uses `Math.random()`; short codes should not be treated as secrets or access controls.
