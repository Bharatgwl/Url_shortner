# URL Shortener

A learning project built with Node.js, Express, MySQL, and Redis. It creates short links for HTTPS URLs and redirects visitors to the saved destination.

**Current stage: Version 4 complete - two application instances behind Nginx.** These are learning milestones; the npm package version is still `1.0.0`.

## Version stages

| Stage | Status | What was built |
| --- | --- | --- |
| Version 1: working URL shortener | Complete | HTTP server, HTTPS validation, MySQL mappings, six-character case-sensitive codes, collision retries, redirects, and basic error handling |
| Version 2: layered application | Complete | Separate routes, business logic, SQL queries, and connection configuration into modules |
| Version 3: Redis cache and resilience | Complete | Cache-aside, TTL, MySQL fallback, optional Redis startup, reconnection, 500 ms waiting deadline, five-second cooldown, and queue limit |
| Version 4: multiple instances and load balancing | Complete | Two host Node.js processes on ports 8000/8001 behind Docker Nginx on 8080; shared MySQL/Redis; distribution, failover, and recovery verified locally |
| Version 5: background analytics | Planned | Record click events through a queue and worker |
| Version 6: evaluate service separation | Planned | Consider independent generation and redirect services based on measured needs |

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

## Current architecture

Nginx in Docker exposes one local entry point at `http://localhost:8080` and distributes requests across two Node.js processes on host ports 8000 and 8001. Both use the same local MySQL database and Docker Redis cache.

```text
Client -> Nginx :8080 -> App :8000 or App :8001
                         Both -> shared Redis cache
                         Both -> shared MySQL database
```

```text
server.js
routes/linkRoutes.js
services/linkServices.js
repositories/linkRepository.js
config/db.js
config/redis.js
nginx/nginx.conf
```

These are two instances of the same application, not separate generation and redirect microservices. All components still run on one computer.

## Requirements

- Node.js with ES module and top-level await support, and npm.
- A running MySQL server; MySQL Workbench is optional.
- Docker Desktop for the local Redis container. Redis is optional for serving requests, but required to exercise caching.
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
```

Use no trailing slash in `BASE_URL`. It controls returned links, not the listening port. Set `PORT` separately in each terminal as shown below. The current code defaults to port `8888` if `PORT` is absent; the Nginx setup requires explicitly using 8000 and 8001.

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

The port binding exposes Redis only on the local machine. No persistent Redis volume is configured; MySQL remains the source of truth.

### 5. Start both application instances

From the project root, open two PowerShell terminals. In terminal 1:

```powershell
$env:PORT="8000"
node server.js
```

In terminal 2:

```powershell
$env:PORT="8001"
node server.js
```

Each terminal must show its assigned listening port. `node server.js` does not reload edits automatically; restart both processes after code or environment-file changes. Alternatively, `npm run dev` uses globally installed nodemon with the PORT assigned in that terminal.

The server checks MySQL before listening. Redis connects in the background, so its ready message may appear before or after the listening message:

```text
Database connected
Server listening on 8000
Redis ready: caching available
```

If Redis is down, connection errors and reconnect attempts are logged, but MySQL-backed requests can still be served. If the initial MySQL check fails, the server does not start listening.

### 6. Start Nginx

From the project root in another PowerShell terminal, create the container once:

```powershell
docker run -d --name url-shortener-nginx -p 127.0.0.1:8080:80 --mount "type=bind,source=$($PWD.Path)\nginx\nginx.conf,target=/etc/nginx/nginx.conf,readonly" nginx:stable-alpine
```

For later runs, use `docker start url-shortener-nginx`. Nginx reaches the host applications through `host.docker.internal:8000` and `:8001`. The mounted config is `nginx/nginx.conf`.

Check `http://localhost:8080/health` and send application requests through port 8080. Both Node.js terminals log their handled requests. Direct ports 8000/8001 are for local checks; generated links use 8080.

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

## Request flows

**Create:** client sends URL -> server validates -> generates code -> inserts mapping -> returns short URL. A duplicate code triggers another attempt, up to five total attempts.

**Open:** browser sends code -> service checks Redis when ready and outside cooldown -> a hit returns immediately; a miss queries MySQL and caches a found mapping -> route returns a redirect or 404 -> browser requests the destination website.

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

## Current limits and future work

This is a local learning setup with two application processes, one Nginx container, one MySQL database, and one optional Redis cache on the same computer. Application-process failover is verified, but a machine failure still stops the entire setup. `localhost` links are not public shareable links.

The waiting deadline does not cancel underlying Redis commands. Cooldown state is per application process; simultaneous misses are not coalesced. Cache outages transfer traffic to MySQL. The queue limit is not an HTTP rate limit, and there is no overall HTTP request deadline.

Next is Version 5: background click analytics. Later work includes automated tests, deployment, rate limiting, abuse controls, URL expiry, and measured scaling. POST retry idempotency is not implemented. Cache TTL expires only the cached copy; URL mappings currently have no expiry. There are no user accounts, QR codes, or destination safety checks. Code generation uses `Math.random()`; short codes should not be treated as secrets or access controls.
