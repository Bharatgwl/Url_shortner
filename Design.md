# URL Shortener Design

## Version stages and current status

**Current stage: Version 5 core analytics implemented and locally tested, including two consumers, retry handling, a failed stream, and pending-event recovery.** Version labels describe learning milestones, not npm releases; package.json remains at 1.0.0.

| Stage | Status | Implementation | Validation |
| --- | --- | --- | --- |
| Version 1: functional URL shortener | Complete | Node.js/Express server; HTTPS validation; MySQL schema and pool; six-character codes; case-sensitive primary key; five collision attempts; POST /links and GET /:code; normalized URL storage; environment settings | Valid and invalid input; 201 creation; 302 redirect; 404 for unknown code; duplicate-code retries; repeated destinations; persistence across restarts |
| Version 2: layered application | Complete | Extracted config/db.js, repositories/linkRepository.js, services/linkServices.js, and routes/linkRoutes.js; validation and creation logic in the service; HTTP responses in routes; SQL in repository | Syntax checks and create/open/error flows after refactoring; corrected /health registration order; corrected missing short-code generation during refactor |
| Version 3: Redis cache and resilience | Complete | Redis in Docker; cache-aside reads; 300-second TTL; MySQL fallback; background connection and reconnection; 500 ms application waiting deadline; five-second cooldown; queue limit 100; offline queue disabled | Cache GET/TTL; hits and misses; stopped and stalled Redis; startup without Redis; reconnection; cooldown and recovery; queue saturation and 120 concurrent HTTP requests |
| Version 4: multiple application instances | Complete | PORT configuration; two host Node.js instances on 8000/8001; shared MySQL/Redis; Docker Nginx on 8080; BASE_URL set to the common address | Cross-instance link access; round-robin logs; GET and POST with 8001 unavailable; redirect and recovery verified |
| Version 5: background analytics | Implemented; local tests passed | Separate Redis Streams queue; bounded publishing; click_events deduplication; named consumers; three-attempt failure handling; failed stream; XAUTOCLAIM recovery after 60 seconds idle | Publish/save/ACK; duplicate save; worker backlog and queue recovery; controlled failure then valid processing; two consumers; user-confirmed pending recovery and MySQL row |
| Version 6: evaluate service separation | Planned | Consider separate URL-generation and redirect services when justified by measured needs | Define requirements and measure before splitting |

Version 1 queried MySQL directly for redirects. Version 2 changed code organization while retaining one process. Version 3 added the external cache and cache-failure handling. The sections below describe the latest implementation.

Two application processes, two analytics worker processes, and MySQL run locally. Separate cache Redis and queue Redis containers, plus Nginx, run in Docker. Nginx distributes HTTP requests to the host applications; workers consume analytics independently. Generation and redirect logic remain in the same application.

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
| server.js | Initialize the application, check MySQL, connect cache and queue Redis in the background, and listen for HTTP requests |
| routes/linkRoutes.js | Read requests and send HTTP responses |
| services/linkServices.js | Validate URLs, generate codes, retry collisions, and manage cache-aside lookups and fallback |
| repositories/linkRepository.js | Execute parameterized SQL queries |
| config/db.js | Configure the MySQL connection pool |
| config/redis.js | Configure the Redis client, queue limit, and connection events |
| nginx/nginx.conf | Reverse proxy and round-robin upstream group for ports 8000/8001 |
| config/queueRedis.js | Separate Redis queue connection on port 6380, offline queue disabled and command queue capped at 100 |
| queues/clickQueue.js | Generate a click UUID and UTC timestamp, then publish through bounded XADD |
| repositories/clickRepository.js | Parameterized click insert; treat duplicate event_id as already saved |
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

## Version 4: load balancing and verified results

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

The current click_events table has event_id VARCHAR(36) as primary key, shortcode VARCHAR(36), and occurred_at DATETIME(3), all NOT NULL. The repository stores occurred_at as a UTC-derived SQL date-time string; DATETIME itself carries no timezone. Each real click gets a fresh UUID; a processing retry retains the original UUID.

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
- Streams currently retain ACKed entries; no trimming policy, retention limit, or replay tool is implemented. Failed events are stored, not automatically fixed or replayed.
- Recovery depends on workers reaching the claim step and Redis being available. Unique consumer names are required for simultaneously running processes. Graceful shutdown and broader failure/load tests remain follow-up work.
- Planned extensions include failed-event replay, retention, stronger delivery coordination, a later Kafka migration, and measurement before separating generation and redirect services. Visitor IP/browser/unique-user analytics, POST retry idempotency, and production deployment remain outside the current implementation.
