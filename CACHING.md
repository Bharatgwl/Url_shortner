# Redis Caching: Concepts and Learning Notes

## Name of the design

The main pattern is **cache-aside**, also called **lazy loading**. This project combines a shared Redis cache with MySQL fallback, an application waiting deadline, a simple failure cooldown, and a bounded Redis client queue.

Caching avoids repeated database reads. Resilience mechanisms control what happens when the optional cache is unhealthy.

## Concepts used

| Term | Meaning | Our implementation |
| --- | --- | --- |
| Cache-aside / lazy loading | Application checks the cache, loads from the database on a miss, then fills the cache | getOGurl checks Redis before MySQL |
| Shared external cache | Cache runs outside Node.js and can be shared by application instances | Redis in Docker |
| Source of truth | Authoritative stored data | MySQL holds mappings; Redis copies are disposable |
| Cache hit | Mapping exists in Redis | Return the URL without a MySQL lookup |
| Cache miss | Redis successfully reports an absent key | GET returns null; query MySQL and cache a found URL |
| TTL / expiration | Remove a cached copy after a configured lifetime | EX: 300; MySQL row is unaffected |
| Graceful degradation / cache fail-open | Continue serving when caching fails | Fall back to MySQL |
| Waiting deadline | Limit how long the application waits for an operation | Promise.race against a 500 ms timer |
| Circuit-breaker-style cooldown | Temporarily bypass an unhealthy dependency | Skip Redis for five seconds after a cache failure |
| Bounded queue / load shedding | Reject new queued work when capacity is reached | commandsQueueMaxLength: 100 |
| Offline queue disabled | Avoid accumulating commands while disconnected | disableOfflineQueue: true |
| Reconnection | Restore the cache connection in the background | Redis client retries; ready event reports recovery |

The cooldown is a simplified circuit-breaker mechanism. It has no controlled single half-open probe or shared state across servers. The queue limit bounds pending client work; it is not an HTTP rate limiter or a complete backpressure system.

## Normal redirect flow

1. The route calls getOGurl(code).
2. If Redis is ready and cooldown has expired, look up url:<code>.
3. On a hit, return the URL immediately.
4. On a miss, query MySQL.
5. Cache a found URL for 300 seconds, then return it.
6. Return null for an unknown code; the route returns 404.

Only found mappings are cached. Unknown codes are not cached (negative caching is not implemented). Creating a link writes MySQL; its first read fills Redis.

## Understanding if, catch, and return

- A false if condition does not trigger catch. Execution continues after that block.
- A missing Redis key returns null. This is a normal cache miss, not an error.
- catch runs when code inside try throws, including rejection of an awaited promise.
- return exits the current function. Returning the MySQL lookup from the cache-error catch skips the lower lookup and cache-write code.
- Each getOGurl call performs at most one MySQL lookup in this implementation.
- MySQL errors propagate to the route, which returns 500.

## Understanding the waiting deadline

A callback is a function passed to another function. The Promise constructor calls its executor callback immediately with resolve and reject functions. setTimeout schedules a callback to run later without blocking normal execution.

Promise.race uses the first promise to settle, whether fulfilled or rejected:

- Redis replies in 100 ms: return that result and clear the timer.
- Redis stays stalled: after approximately 500 ms, reject with the timeout error.
- Redis errors immediately: propagate the error without waiting for the timer.

The caller catches a cache error and uses MySQL. finally clears the timer on success or failure, before the function finishes returning.

This limits waiting, not Redis execution. The underlying command can remain pending. A timed-out cache write can still execute later. This is not cancellation or an exact whole-request deadline.

The client commandOptions.timeout setting was removed: testing and inspection showed it did not bound waiting for an already-sent command's reply. The application wrapper is the tested protection for stalled replies.

## Failure handling

| Situation | Behavior |
| --- | --- |
| Cache lookup fails or times out | Start five-second cooldown; return MySQL lookup directly; skip cache write |
| Redis disconnected or cooldown active | Skip cache lookup; query MySQL |
| Cache write fails or times out | Start cooldown; still return the URL obtained from MySQL |
| Queue full | Redis rejects new work; cache catch falls back to MySQL |
| MySQL fails on a required lookup | Propagate the error; route returns 500 |

The cache-write condition checks readiness and cooldown again. If cooldown expires during a database lookup, the write may be attempted.

## Configuration

| Setting | Value |
| --- | --- |
| Redis key | url:<case-sensitive code> |
| TTL | 300 seconds |
| Per-cache-operation waiting deadline | 500 ms |
| Failure cooldown | Five seconds, stored in process memory |
| Client queue limit | 100 |
| Offline queueing | Disabled |

Limit 100 is a learning configuration, not a tuned production capacity. Limit 2 failed during the Redis connection handshake because startup commands also use the queue.

## Verification

See Design.md for measured results. Tests covered cache hits, expiry, disconnection, startup without Redis, reconnection, stalled replies, cooldown, recovery, and queue saturation.

The controlled service test produced 20 queue-full errors and 100 waiting timeouts from 120 simultaneous lookups; all returned a URL through fallback. A separate live HTTP test returned 120 responses with status 302 while Redis was paused.

The small local timing samples do not prove a reliable performance improvement. The concurrent test verifies resilience in that scenario, not maximum throughput.

## Remaining limitations

- Waiting deadlines do not cancel pending Redis commands; queue capacity only bounds them.
- Cooldown is local to each process, resets on restart, and does not coordinate simultaneous requests.
- Simultaneous misses can query MySQL repeatedly for the same key: a cache stampede. Request coalescing is not implemented.
- Cache failure transfers traffic to MySQL. There is no guarantee MySQL can sustain arbitrary fallback traffic.
- A cache miss followed by a stalled write can add another waiting deadline. No overall HTTP request budget is enforced.
- TTL is the current freshness mechanism. Adding URL edits or deletion will require cache invalidation rules.
- Warm keys may redirect during a MySQL outage; misses and creation still depend on MySQL.
- Production metrics for hit ratio, tail latency, queue depth, and database load are not implemented.

## Project explanation for interviews

Implemented Redis cache-aside for URL redirects with a five-minute TTL and MySQL as the source of truth. Added cache-failure fallback, a 500 ms application waiting deadline, a five-second failure cooldown, and a bounded client queue. Verified outage, stall, recovery, and queue-saturation behavior locally.
