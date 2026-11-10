# URL Shortener Design

## Version stages and current status

**Current stage: Version 7 complete for the agreed learning milestone: two replicas per HTTP role, per-role round robin, and local single-instance failover/recovery.** Version labels describe learning milestones, not npm releases; package.json remains at 1.0.0.

| Stage | Status | Implementation | Validation |
| --- | --- | --- | --- |
| Version 1: functional URL shortener | Complete | Node.js/Express server; HTTPS validation; MySQL schema and pool; six-character codes; case-sensitive primary key; five collision attempts; POST /links and GET /:code; normalized URL storage; environment settings | Valid and invalid input; 201 creation; 302 redirect; 404 for unknown code; duplicate-code retries; repeated destinations; persistence across restarts |
| Version 2: layered application | Complete | Extracted config/db.js, repositories/linkRepository.js, services/linkServices.js, and routes/linkRoutes.js; validation and creation logic in the service; HTTP responses in routes; SQL in repository | Syntax checks and create/open/error flows after refactoring; corrected /health registration order; corrected missing short-code generation during refactor |
| Version 3: Redis cache and resilience | Complete | Redis in Docker; cache-aside reads; 300-second TTL; MySQL fallback; background connection and reconnection; 500 ms application waiting deadline; five-second cooldown; queue limit 100; offline queue disabled | Cache GET/TTL; hits and misses; stopped and stalled Redis; startup without Redis; reconnection; cooldown and recovery; queue saturation and 120 concurrent HTTP requests |
| Version 4: multiple application instances | Complete | PORT configuration; two host Node.js instances on 8000/8001; shared MySQL/Redis; Docker Nginx on 8080; BASE_URL set to the common address | Cross-instance link access; round-robin logs; GET and POST with 8001 unavailable; redirect and recovery verified |
| Version 5: background analytics | Complete; local tests passed | Separate Redis Streams queue; bounded publishing; MySQL deduplication; two consumers; retries and failed stream; XAUTOCLAIM recovery; stats endpoint and shortcode index | Publish/save/ACK; duplicates; queue and worker recovery; three-failure handling; two consumers; stats cases; EXPLAIN comparison; corrected manual replay |
| Version 6: creation/redirect separation | Complete; local tests passed | Creation server on 8000; redirect/stats server on 8001; separate routers; Nginx exact-path and fallback routing | Direct route ownership, full flow through 8080, independent service failures, recovery, and agent no-follow HTTP checks |
| Version 7: service replicas and failover | Complete; local tests passed | Creation 8000/8002; redirect 8001/8003; round robin within each role and default passive failover | User-confirmed health, request distribution, stopped-instance continuity, and recovery in both roles |

Version 1 queried MySQL directly for redirects. Version 2 changed code organization while retaining one process. Version 3 added the external cache and cache-failure handling. The sections below describe the latest implementation.

Creation and redirect each run as two separate Node.js processes, alongside analytics workers and MySQL on the host. Cache Redis, queue Redis, and Nginx run in Docker. Nginx routes requests by path to the appropriate service role; workers consume analytics independently. Shared business/repository modules and the database remain in one repository and deployment environment.

## Requirements

- Stack: Node.js, Express, MySQL, and Redis.
- Accept valid HTTPS destination URLs.
- Generate a new six-character, case-sensitive code for every submission.
- Multiple codes may point to the same destination; existing links remain valid.
- Store mappings permanently in MySQL; keep temporary copies in Redis.
- Return 302 for known codes, 404 for unknown codes, and 400 for invalid input.

## Components and responsibilities

| Component | Responsibility |
| --- | --- |
| creationServer.js | Check MySQL, mount creation routes, expose health, and listen on 8000 by default |
| redirectServer.js | Check MySQL, connect cache/queue Redis in the background, mount redirect/stats routes, and listen on 8001 by default |
| routes/creationRoutes.js | POST /links validation/creation HTTP responses |
| routes/redirectRoutes.js | GET /:code publication/redirect and GET /links/:code/stats HTTP responses |
| server.js and routes/linkRoutes.js | Legacy combined entry point/router retained from earlier versions |
| services/linkServices.js | Validate URLs, generate codes, retry collisions, and manage cache-aside lookups and fallback |
| repositories/linkRepository.js | Execute parameterized SQL queries |
| config/db.js | Configure the MySQL connection pool |
| config/redis.js | Configure the Redis client, queue limit, and connection events |
| nginx/nginx.conf | Exact /links to creation group 8000/8002; other paths to redirect group 8001/8003; per-role round robin and passive failover |
| config/queueRedis.js | Separate Redis queue connection on port 6380, offline queue disabled and command queue capped at 100 |
| queues/clickQueue.js | Generate a click UUID and UTC timestamp, then publish through bounded XADD |
| repositories/clickRepository.js | Parameterized click insert, duplicate event-ID handling, and shortcode-filtered count query |
| workers/clickWorker.js | Read own pending events, reclaim idle entries, read new events, save, ACK, and retry |
| queues/clickRetries.js | Redis hash counters keyed by stream entry ID |
| queues/failedClickQueue.js | Copy failed events with error details into the failed stream |
| utils/withTimeout.js | Limit application waiting for publishing/cache operations; does not cancel Redis commands |

## API

| Action | Endpoint | Result |
| --- | --- | --- |
| Health check | GET /health | 200; confirms the HTTP server responds, not a fresh database check |
| Create link | POST /links | Receives original_url; returns short_url with 201 |
| Open link | GET /:code | 302 with Location header, or 404 if no mapping exists |
| Link statistics | GET /links/:code/stats | 200 with shortcode and numeric total_clicks; existing unvisited link returns zero; unknown code returns 404 |

Register /health before the general /:code router.

## MySQL schema

| Column | Type | Constraint |
| --- | --- | --- |
| shortcode | VARCHAR(6), ASCII, ascii_bin collation | Primary key; case-sensitive |
| original_url | TEXT | NOT NULL; duplicates allowed |
| created_at | TIMESTAMP(6) | NOT NULL DEFAULT CURRENT_TIMESTAMP(6) |

Generate a candidate, attempt insertion, and retry ER_DUP_ENTRY up to five total attempts. Other database failures are returned to the route immediately.

## Redirect flow with caching

1. If Redis is ready and the cooldown has expired, look up url:<code>.
2. On a cache hit, return the URL without querying MySQL.
3. On a cache miss, query MySQL and cache a found mapping for 300 seconds.
4. On a Redis lookup error or a 500 ms waiting deadline, set a five-second cooldown and return the MySQL lookup result directly.
5. During disconnection or cooldown, skip Redis and use MySQL.
6. A failed cache write starts the cooldown but does not discard the URL obtained from MySQL.
7. Return null for an unknown mapping; the route sends 404. MySQL failures propagate to the route as 500.

## Completed implementation

- [x] HTTP server and health route
- [x] MySQL schema and connection pool
- [x] Link creation, validation, and collision retries
- [x] Case-sensitive redirects and persistence across restarts
- [x] Routes, services, repositories, and configuration separated
- [x] Redis cache-aside lookup with TTL
- [x] MySQL fallback, non-blocking Redis startup, and reconnection
- [x] Application waiting deadline, cooldown, and queue limit
- [x] Two application instances behind Nginx
- [x] Separate analytics Redis queue and bounded event publishing
- [x] MySQL click-event persistence and event-ID deduplication
- [x] Two named consumer workers and save-before-ACK ordering
- [x] Three-attempt save-failure handling and failed stream
- [x] Idle pending-event recovery through XAUTOCLAIM
- [x] Stats API, zero-click and unknown-code handling, and shortcode count index
- [x] Manual corrected failed-event replay verified; automatic tooling remains deferred
- [x] Separate creation and redirect entry points and routers
- [x] Nginx path routing and independent service failure/recovery checks
- [x] Two HTTP replicas per role, per-role distribution, single-instance failover, and recovery

## Version 3: verified results

Tests used http://localhost:8000/qH6jEB. HTTP clients did not follow redirects. Timings measure the shortener response, not the destination website. Values below are observations, not production guarantees.

| Test | Conditions | Observed result | Evidence / meaning |
| --- | --- | --- | --- |
| Baseline without Redis caching | Six sequential local requests | All 302; average 3.35 ms, range 2.84-3.96 ms | Baseline only |
| After caching | Eight sequential local requests | All 302; average 2.96 ms, range 2.76-3.10 ms | Small samples do not establish a reliable speedup |
| Cached mapping and expiry | Redis running | GET returned the destination; TTL was 216 seconds | Mapping stored with an expiry |
| Redis stopped | Live HTTP test | 302 through fallback | MySQL serves redirects during Redis disconnection |
| Startup without Redis | Redis unavailable at startup | Server started; redirect worked | Redis is optional for application startup |
| Redis restart | Redis restarted after outage | Two 302 responses; Redis GET counter increased by two | Client reconnected and resumed cache lookups |
| Stalled Redis before deadline fix | Container paused | Curl timed out after approximately 5 seconds | Earlier client command-timeout option did not bound reply waiting |
| Stalled Redis after deadline fix | Container paused | 302 in 518.439 ms | Application waiting deadline enabled MySQL fallback |
| Redirect after unpause | Container resumed | 302 in 9.347 ms | HTTP service remained functional |
| Cooldown: first request | Redis paused | 302 in 503.244 ms | Initial timeout followed by MySQL fallback |
| Cooldown: immediate second request | Redis still paused, within five seconds | 302 in 2.386 ms | Cooldown skipped Redis |
| Cache recovery after cooldown | Redis unpaused; cooldown expired | User observed two fresh Cache HIT logs | Cached reads resumed; recovery check complete |
| Queue limit too small | Limit temporarily set to 2 | Redis handshake failed with queue-full errors | Startup commands also need queue capacity; restored limit to 100 |
| Queue saturation: isolated service test | Actual service imported in a separate process; Redis paused; 120 simultaneous lookups; limit 100 | 20 queue-full errors, 100 waiting timeouts; all 120 returned a URL; approximately 517 ms for the batch | Queue rejection and timeout both fell back to MySQL |
| Queue saturation: live HTTP test | Redis paused; 120 concurrent requests | 120 responses with status 302 | Live HTTP requests survived the test; Redis unpaused afterward |

## Version 4: historical load balancing and verified results

Public local entry point: `http://localhost:8080`. Nginx listens on container port 80 and forwards to `host.docker.internal:8000` or `:8001`. Both application instances use the same database and Redis, while each has its own connection pool and in-memory cache cooldown.

`PORT` selects each process's listening port; the current fallback is 8888. `BASE_URL=http://localhost:8080` generates client-facing links. It is used during link creation, not appended during redirect lookup.

| Test | Observed result | Evidence source |
| --- | --- | --- |
| Direct health checks | Both 8000 and 8001 returned 200 | Agent checks and user confirmation |
| Cross-instance mapping | Link created on 8000 opened on 8001 | User test |
| Distribution through 8080 | Both instance terminals received requests | Agent background-instance logs and user terminal confirmation |
| GET failover with 8001 unavailable | Six requests through Nginx returned 200 | Agent-controlled HTTP test |
| POST with 8001 unavailable | 201 with a short URL using port 8080 | Agent-controlled HTTP test |
| Redirect with 8001 unavailable | 302 with the correct destination | Agent-controlled HTTP test |
| Recovery after restarting 8001 | Both direct checks returned 200; ten Nginx checks returned 200; 8001 received traffic again | Agent-controlled HTTP test and instance logs |
| Process ownership cleanup | Agent-started 8001 stopped; user restarted it and observed logs | Agent verification followed by user confirmation |

These tests verify local process failover, not machine-level high availability or throughput scaling. Successful POST creation while one instance is already down does not prove safe retries after a partially completed POST. Nginx has no custom active health probe or explicit timeout policy in this config. See SCALING.md for details.

## Configuration and limitations (current)

| Setting | Current value |
| --- | --- |
| Cache key | url:<case-sensitive code> |
| Cache TTL | 300 seconds |
| Per-cache-operation waiting deadline | 500 ms |
| Failure cooldown | 5 seconds, local to each Node.js process |
| Redis pending-command queue limit | 100 |
| Offline command queueing | Disabled |

The queue limit is a learning configuration, not a tuned capacity estimate. The waiting deadline does not cancel sent Redis commands. The cooldown reduces retries but does not cancel existing work or coordinate simultaneous requests. See CACHING.md for concepts and remaining gaps.


## Version 5: background click analytics

### Storage and terms

| Name | Meaning |
| --- | --- |
| analytics:clicks | Original Redis stream containing click events |
| click-workers | Consumer group distributing new events among its consumers |
| worker-1 / worker-2 | Consumer names supplied as process arguments; same file, separate Node.js processes |
| Group pending list (PEL) | Delivered stream entry IDs that have not been ACKed, with consumer ownership |
| analytics:clicks:failures | Redis hash containing save-failure counts keyed by original stream entry ID |
| analytics:clicks:failed | Failed-event stream retained for investigation and future replay |
| event_id | Application UUID; MySQL primary key used to deduplicate repeated processing |
| entry.id | Redis-generated stream entry ID used for ACK, claiming, and failure counters |

The queue Redis instance uses host port 6380; cache Redis uses 6379. Separate clients connect each process to those Redis servers. A client is a connection object, not a stream or a worker. The group is created once with `XGROUP CREATE analytics:clicks click-workers 0 MKSTREAM`; consumers are registered when used by group commands.

The current click_events table has event_id VARCHAR(36) as primary key, shortcode VARCHAR(36) with ASCII/ascii_bin case-sensitive collation, and occurred_at DATETIME(3), all NOT NULL. The repository stores occurred_at as a UTC-derived SQL date-time string; DATETIME itself carries no timezone. Each real click gets a fresh UUID; a processing retry retains the original UUID.

### HTTP and worker flows

```text
POST /links -> validate -> generate code -> insert mapping -> 201 short URL

GET /:code -> cache/MySQL destination lookup
  unknown -> 404, no click publication
  found -> bounded XADD attempt -> 302 redirect
  queue error/timeout -> log -> still 302

analytics:clicks -> worker -> MySQL click_events -> ACK -> clear counter
```

The redirect route awaits publishing for up to the 500 ms application deadline. It does not wait for analytics processing. A cache hit still produces a click event. Queue availability is deliberately not required for redirects, so analytics is best effort before successful enqueueing; there is no end-to-end exactly-once guarantee.

### Worker decision flow

1. Connect once to queue Redis. Use the command-line consumer name, defaulting to worker-1.
2. Read this consumer's own pending entries using XREADGROUP with ID `0`, COUNT 1.
3. If none were returned, call XAUTOCLAIM with the consumer name, a 60,000 ms minimum idle time, the saved scan cursor, and COUNT 1. Save nextId for the next scan. A returned entry becomes owned by this consumer.
4. If no entry was obtained, read new group entries using ID `>`, COUNT 1, BLOCK 5000. If no event arrives, start the loop again.
5. Attempt to save the event in MySQL. A duplicate event_id is treated as already saved, allowing processing to proceed to ACK.
6. On success, ACK the original stream entry, clear its failure counter, and continue.
7. On save failure, increment its Redis failure counter. On failures one and two, wait one second and leave the event pending for retry.
8. At failure three or higher, publish the original event and failure metadata to analytics:clicks:failed. Only after successful publication, ACK the original and clear the counter. A failed publish leaves the original pending.
9. Other processing errors are logged; the loop waits one second before trying again. Startup errors follow the separate outer catch.

Own-pending work takes priority over claiming and new work. The 60-second threshold is an idle-time criterion, not a crash detector or an exact recovery deadline. A healthy worker taking too long may also have its event claimed. Claiming changes group ownership; it does not assign a new application event_id or remove the original stream entry. ACK clears the group's pending tracking; stream deletion/trimming is separate.

### Verified local results

| Scenario | Result | Evidence source |
| --- | --- | --- |
| Known redirect publishes an event | 302; stream entry contains event_id, shortcode, occurred_at | User HTTP request and XREVRANGE output |
| Worker save and ACK | MySQL save/ACK logs; subsequent pending read empty and XPENDING zero | User worker output |
| Save same event_id twice | One row; UTC timestamp preserved | Agent repository test using a transaction and rollback |
| Worker restarted with backlog | Queued events processed after restart | User worker logs |
| Queue stopped and restarted | Three redirects returned 302 while down; client ready and later event processing confirmed after restart | User terminal output; not evidence that outage clicks were retained |
| Oversized shortcode followed by valid event | Exactly three save failures; failed stream attempts=3 with matching source entry ID; invalid MySQL rows=0; following valid rows=1; test pending=0; counters cleared | Agent-controlled test of the actual worker; temporary worker stopped and test entries/rows removed |
| Two consumers | Both worker terminals showed Event processed | User confirmation |
| Pending event owned by stopped worker-1 | Pending=1 owned by worker-1; worker-2 started; pending became 0 and recovered shortcode NJ75eh was confirmed in MySQL | User-controlled recovery test and SQL confirmation |

The recovery fixture used stream entry ID 1794256187754-0. Its application event_id was accidentally the literal text `static guid NewGuid()` because PowerShell `NewGuid` was referenced without calling it. MySQL accepted that string; the test verified pending recovery but did not verify valid UUID creation for that manual fixture. Correct manual generation is `[guid]::NewGuid().ToString()`. The application's publisher uses Node.js randomUUID().

### Delivery trade-offs and remaining work

- After enqueueing, pending redelivery and retries provide at-least-once processing attempts under the tested conditions. The MySQL primary key makes repeated processing idempotent for the event row. This is not an end-to-end exactly-once claim.
- Queue outages can lose click events because the HTTP route continues to redirect. A publish timeout only stops waiting; an append might still complete later. No durable application outbox or publisher retry is implemented.
- AOF and the named queue volume provide persistence, but durability still depends on Redis configuration and the failure type. Host-level redundancy is absent.
- All save errors currently share the same three-failure policy. A temporary MySQL outage can move otherwise valid events to the failed stream; transient versus permanent error classification remains future work.
- Publishing to the failed stream, ACKing the original, and clearing its counter are separate commands. A crash between publish and ACK can duplicate the failed-stream record; a crash after ACK can leave a stale counter. The transfer is not atomic.
- Streams currently retain ACKed entries; no trimming policy, retention limit, or replay tool is implemented. A corrected test event was replayed manually; failed events are not automatically fixed or replayed.
- Recovery depends on workers reaching the claim step and Redis being available. Unique consumer names are required for simultaneously running processes. Graceful shutdown and broader failure/load tests remain follow-up work.
- Planned extensions include replay tooling, retention, stronger delivery coordination, a later Kafka migration, and measurement before separating generation and redirect services. Visitor IP/browser/unique-user analytics, POST retry idempotency, and production deployment remain outside the current implementation.


### Stats API and index verification

GET /links/:code/stats -> getLinkStats(code) -> check links mapping -> return null/404 if absent -> countClicksByCode(code) -> parameterized COUNT(*) -> 200 with shortcode and total_clicks. This route does not call the publisher. An existing link with no click rows returns zero. Event processing is asynchronous, so counts can lag redirects.

| Verified case | Observation |
| --- | --- |
| Existing link | NJ75eh returned numeric total_clicks=48 in user output |
| Repeated stats read | User confirmed no additional click recorded |
| One short-link request | User confirmed count increased after Event processed |
| Unknown code | User confirmed 404 |
| New, unvisited link | User confirmed uEtffX returned zero; requested uEtffx was absent because code matching is case-sensitive |

The user created idx_click_events_shortcode on click_events(shortcode). Before indexing, EXPLAIN showed type=ALL, key=NULL, rows=100, Using where. After indexing, it showed type=ref, key=idx_click_events_shortcode, rows=50, Using index. These row counts are optimizer estimates; they do not establish a measured speedup. Using index indicates a covering index plan. A useful simplified model for this indexed count is O(log N + K), where N is total indexed events and K is matching entries. The count is not a ready-made O(1) hash-map value. The secondary index consumes storage and is maintained during writes.

### Manual failed-event replay verification and milestone closure

The invalid test event in failed entry 1794253704343-0 had an oversized shortcode and three recorded failures. At the user's request, its shortcode was corrected to the existing test link NJ75eh. Application event_id 7164b9e7-b166-4184-a1e0-7b63d2c32097 and occurred_at were preserved, and XADD created new original-stream entry 1794260087201-0. Existing workers processed it. Agent checks confirmed exactly one MySQL row with NJ75eh and UTC time 2026-11-09 19:48:22.186, replay pending=0, no remaining failure counter, and the original failed-stream entry retained. This deliberately added one synthetic click to the link's count. No general replay tool was implemented, and this single replay did not test repeated replay deduplication; duplicate-save behavior was tested separately.

Version 5 closes at background analytics, retries/failed storage, two consumers, idle pending recovery, stats, indexing, and this manual replay verification. Replay tooling, retention, Kafka migration, and the delivery gaps listed above remain separate future work; they are not prerequisites for closing this learning milestone.


## Version 6: historical creation and redirect service separation

### Scope and route ownership

The learning objective was to separate HTTP responsibilities and test independent process failures. This split is an architecture exercise; no traffic measurements established a production need for independently deployed services. Each service currently has one instance, and both share the same repository, business/repository modules, and MySQL database.

| Service | Entry point | Host port | Routes | Runtime connections |
| --- | --- | --- | --- | --- |
| Creation | creationServer.js | 8000 | POST /links; GET /health | MySQL |
| Redirect | redirectServer.js | 8001 | GET /:code; GET /links/:code/stats; GET /health | MySQL, cache Redis, queue Redis |

Nginx container port 80 is published at host 127.0.0.1:8080. The project's nginx/nginx.conf is bind-mounted read-only at /etc/nginx/nginx.conf. `host.docker.internal` reaches the host service ports from the container. Nginx runs independently of Node.js and reads config at startup/reload. User applied the new config after syntax validation and reload.

The exact location `= /links` forwards to creation_service. The fallback `/` forwards to redirect_service, including stats paths. Matching is by path; Express routes select supported HTTP methods. A missing `=` would send stats paths to creation and return 404. The `/links/` trailing-slash path uses the fallback, so clients should use the documented `/links`. Public `/health` checks redirect only; inspect both direct health endpoints to check both processes.

### Verified local results

| Scenario | Result | Evidence source |
| --- | --- | --- |
| Health | Both direct service health endpoints returned 200 | User HTTP output |
| Direct creation/redirect | POST on creation returned 201; valid code on redirect returned 302 | User confirmation and pasted HTTP response |
| Wrong service | GET of valid code on creation and POST /links on redirect returned 404 | User checks and confirmation |
| Stats | Direct stats on redirect returned 200 | User confirmation |
| Nginx routing | POST reached 8000; redirects/stats reached 8001; new-link count went from zero to one after processing | User confirmation of guided test |
| Creation unavailable | POST returned 502 while existing redirect returned 302; POST recovered to 201 after restart | User confirmation of guided test |
| Redirect unavailable | Creation stayed 201; redirect/stats requests failed with 502; recovered after restart | User confirmation of guided test |
| Redirect recovery checked independently | Agent observed 302 through 8080, 302 directly on 8001, and stats 200 for OPB0SQ | Curl without redirect following |

The user's client displayed 403 after restart. Agent checks verified that the shortener returned 302 to LeetCode; the 403 likely came from the destination after the client followed the redirect. The external 403 source was not independently verified. Those two agent redirect checks also generated normal test click events.

### Closure and remaining limits

The agreed V6 finish line is reached: separate entry points/routers, Nginx role routing, direct and common-entry HTTP checks, independent failure/recovery tests, and updated docs. V4's interchangeable-instance round robin is historical; V6's two processes have different roles and cannot substitute for each other. Version 7 adds multiple instances per role. Throughput measurement, graceful shutdown, Kafka, authentication, and deployment remain future work.

MySQL and the host remain shared failure points. Worker/cache/queue delivery limits from V5 still apply. The existing npm dev script and package main still refer to legacy server.js; use the documented creationServer.js and redirectServer.js commands for V6. No package scripts, ports, credentials, environment files, or service settings were changed by the documentation update.


## Version 7: per-role replicas and failover

### Scope and architecture

The same creationServer.js file runs twice, on 8000 and 8002. The same redirectServer.js file runs twice, on 8001 and 8003. Each invocation is an independent Node.js process with PORT explicitly assigned in its terminal. No new HTTP service implementation was required. All use the existing repository modules and shared MySQL; the two redirect instances also connect to shared cache Redis and queue Redis. Analytics workers remain separate processes.

```text
Client -> Nginx :8080
  exact /links -> creation_service -> :8000 or :8002
  other paths -> redirect_service -> :8001 or :8003
```

Each upstream uses default round robin. One role's instances can substitute for each other; creation cannot substitute for redirect or vice versa. The exact /links routing rule and stats/public-health ownership remain as documented in V6. Each Node.js process has its own connection pools and module state, including each redirect process's cache cooldown; Redis mappings and MySQL rows are shared.

### Passive failure handling and recovery

Nginx learns upstream failures from actual requests. With the unchanged defaults max_fails=1 and fail_timeout=10s, a failed peer can be temporarily excluded and tried again by live traffic after the interval. The recovery exercise waited 10-15 seconds after process restart and sent more requests. No active periodic application health checks, custom proxy timeouts, or external process supervisor were added. Reference: [Nginx HTTP load balancing](https://nginx.org/en/docs/http/load_balancing.html).

Tests stopped a process before sending requests, producing a connection-refusal scenario. Successful POST failover here does not prove safe replay after a POST was partly processed. Creation still generates a fresh link for every accepted submission; no POST idempotency key exists. Different failures, such as a connected but stalled process, can have different timeout behavior.

### Verified local results

| Scenario | Result | Evidence source |
| --- | --- | --- |
| Added-instance health | 8002 and 8003 returned 200; existing 8000/8001 instances remained running | User confirmation of guided setup |
| Creation round robin | Four POST requests returned 201; both 8000 and 8002 logged requests | User confirmation |
| Redirect round robin | Four requests returned 302; both 8001 and 8003 logged requests | User confirmation |
| Creation 8000 stopped | Four POST requests returned 201 through 8002 | User confirmation of guided test |
| Creation 8000 recovered | After restart and wait, both creation instances logged requests again | User confirmation |
| Redirect 8001 stopped | Four short-link requests returned 302 through 8003; stats returned 200 | User confirmation of guided test |
| Redirect 8001 recovered | After restart and wait, both redirect instances logged requests again | User confirmation |

These V7 runtime results are user-reported confirmations of the guided tests; the agent inspected the four-server config and recorded them without repeating the outage tests. No concurrency benchmark, p95 latency comparison, machine outage, or complete service-group outage was tested in this milestone.

### Milestone closure

V7 closes at two HTTP replicas per role, Nginx per-role round robin, single-instance failover, recovery, and documentation. This is local process redundancy, with all components on one machine. Nginx, MySQL, and the host remain shared failure points. Queue/cache delivery limitations, stream retention, replay tooling, broader performance testing, graceful shutdown, Kafka, and deployment remain separate future work.
