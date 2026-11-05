# URL Shortener Design

## Version stages and current status

**Current stage: Version 3 complete. Version 4 is planned and has not started.** Version labels describe learning milestones, not npm releases; package.json remains at 1.0.0.

| Stage | Status | Implementation | Validation |
| --- | --- | --- | --- |
| Version 1: functional URL shortener | Complete | Node.js/Express server; HTTPS validation; MySQL schema and pool; six-character codes; case-sensitive primary key; five collision attempts; POST /links and GET /:code; normalized URL storage; environment settings | Valid and invalid input; 201 creation; 302 redirect; 404 for unknown code; duplicate-code retries; repeated destinations; persistence across restarts |
| Version 2: layered application | Complete | Extracted config/db.js, repositories/linkRepository.js, services/linkServices.js, and routes/linkRoutes.js; validation and creation logic in the service; HTTP responses in routes; SQL in repository | Syntax checks and create/open/error flows after refactoring; corrected /health registration order; corrected missing short-code generation during refactor |
| Version 3: Redis cache and resilience | Complete | Redis in Docker; cache-aside reads; 300-second TTL; MySQL fallback; background connection and reconnection; 500 ms application waiting deadline; five-second cooldown; queue limit 100; offline queue disabled | Cache GET/TTL; hits and misses; stopped and stalled Redis; startup without Redis; reconnection; cooldown and recovery; queue saturation and 120 concurrent HTTP requests |
| Version 4: multiple application instances | Planned | Configurable listening ports, two instances, shared MySQL and Redis, and a load balancer | Verify distribution and behavior when one instance stops |
| Version 5: background analytics | Planned | Click events, queue, worker, and retry handling | Verify event processing and failure recovery |
| Version 6: evaluate service separation | Planned | Consider separate URL-generation and redirect services when justified by measured needs | Define requirements and measure before splitting |

Version 1 queried MySQL directly for redirects. Version 2 changed code organization while retaining one process. Version 3 added the external cache and cache-failure handling. The sections below describe the latest implementation.

The application and MySQL currently run locally; Redis runs in Docker. There is no application load balancer, separate analytics worker, or independently deployed generation/redirect service yet.

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
| server.js | Initialize the application, check MySQL, start Redis connection in the background, and listen for HTTP requests |
| routes/linkRoutes.js | Read requests and send HTTP responses |
| services/linkServices.js | Validate URLs, generate codes, retry collisions, and manage cache-aside lookups and fallback |
| repositories/linkRepository.js | Execute parameterized SQL queries |
| config/db.js | Configure the MySQL connection pool |
| config/redis.js | Configure the Redis client, queue limit, and connection events |

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

## Configuration and limitations

| Setting | Current value |
| --- | --- |
| Cache key | url:<case-sensitive code> |
| Cache TTL | 300 seconds |
| Per-cache-operation waiting deadline | 500 ms |
| Failure cooldown | 5 seconds, local to each Node.js process |
| Redis pending-command queue limit | 100 |
| Offline command queueing | Disabled |

The queue limit is a learning configuration, not a tuned capacity estimate. The waiting deadline does not cancel sent Redis commands. The cooldown reduces retries but does not cancel existing work or coordinate simultaneous requests. See CACHING.md for concepts and remaining gaps.
