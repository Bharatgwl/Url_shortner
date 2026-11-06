# Version 4: Scaling and Load Balancing

## Current setup

Two Node.js processes run the same application on host ports 8000 and 8001. Nginx runs in Docker and publishes container port 80 as localhost:8080. Both applications use the same MySQL database and Redis cache.

```text
User -> localhost:8080 -> Nginx -> App :8000 or App :8001
                                   Both -> shared MySQL
                                   Both -> shared Redis
```

All components are on one computer. This demonstrates local process failover, not machine-level high availability.

## Concepts learned

| Concept | Meaning here |
| --- | --- |
| Horizontal scaling | Run more instances of the same application |
| Application instance | Independent Node.js process with its own port, memory, and connections |
| Reverse proxy | Nginx accepts requests, forwards them to an application, and relays responses |
| Load balancing | Select an application instance for a request |
| Round-robin | Default Nginx upstream distribution across eligible instances in turn |
| Shared storage | MySQL mappings can be read by either instance |
| Shared cache | Redis entries are accessible from either instance |
| Process failover | Another application process can serve when one is unavailable |
| Recovery | A restarted instance receives traffic again |

These are two copies of one application, not independent creation and redirect microservices. Requests do not need to stay on the instance that created a link.

## Create flow

1. Client sends POST /links to port 8080.
2. Nginx selects an application instance.
3. The service validates the destination, generates a code, and saves it in shared MySQL.
4. The response builds a short URL from BASE_URL plus the code.
5. Nginx relays the response to the client.

## Redirect flow

1. Client requests the short code through port 8080.
2. Nginx selects either instance, regardless of which created the mapping.
3. The instance looks up the code through Redis or MySQL fallback.
4. The application returns 302 with the original destination in the Location header.
5. Nginx relays that response; the browser opens the destination website.

Shared mappings make cross-instance lookup possible. Round-robin only distributes requests. BASE_URL is used during creation; it is not appended to the original URL during redirection.

## Ports and Docker networking

| Setting/address | Purpose |
| --- | --- |
| localhost:8080 | Common local entry point |
| PORT=8000 / PORT=8001 | Listening port assigned to each application process |
| BASE_URL=http://localhost:8080 | Address included in generated short links |
| host.docker.internal:8000 / :8001 | Addresses Nginx uses inside Docker to reach host applications |
| Container port 80 | Nginx listener mapped to host port 8080 |

Container localhost refers to the container itself. Docker Desktop's host.docker.internal reaches the host. The current application fallback port is 8888 when PORT is absent, so explicitly select 8000 and 8001 for this setup. Full startup commands are in README.md.

## What is shared and what is local?

MySQL mappings and Redis cache entries are shared. Each Node.js instance has its own connection pool, Redis client, console logs, and cacheRetryAfter cooldown timestamp. A cache failure can therefore put one process in cooldown while another continues trying Redis.

More application instances also mean more database/cache connections and potentially more database fallback traffic.

## Nginx failure behavior

The current configuration uses an upstream group and proxy_pass. It relies on default passive failure handling; it does not actively poll /health. We call /health manually to verify responses.

A failed upstream can be temporarily avoided, so traffic may not return to a restarted instance on the first request. Exact alternating logs are not guaranteed during failures or recovery.

## Verified tests

| Scenario | Result |
| --- | --- |
| Direct health checks on 8000 and 8001 | Both returned 200 |
| Create on 8000, open on 8001 | User confirmed successful redirect |
| Requests through 8080 | Both instance terminals logged requests |
| 8001 unavailable: six proxy health requests | All returned 200 |
| 8001 unavailable: proxy POST | 201 with a short URL using port 8080 |
| Open that short URL while 8001 unavailable | 302 to the correct destination |
| Restart 8001 | Both direct health checks passed; ten proxy checks returned 200; 8001 received traffic again |

The agent verified the unavailable-8001 scenario. The user also confirmed GET/POST behavior with an instance stopped. These are functional resilience tests, not capacity benchmarks.

## POST retries and idempotency

A successful POST while an instance is already down does not prove safe retries for every failure. An instance could save a mapping and fail before its response reaches the client. Retrying could create another mapping.

Nginx does not blindly replay every non-idempotent request after sending it upstream. This application has no idempotency-key mechanism and does not guarantee exactly-once creation.

## Remaining limits

- One computer: machine failure stops everything.
- One Nginx and one MySQL server: neither is replicated for high availability.
- No active upstream health probing or custom proxy timeout policy.
- No process supervisor or graceful application shutdown.
- No measured throughput increase established by these tests.
- Basic console logging rather than centralized observability.
- Cache resilience remains subject to the limits documented in CACHING.md.

## Interview explanation

Ran two instances of a Node.js URL shortener behind Docker Nginx with round-robin distribution and shared MySQL/Redis. Used a common base URL and verified cross-instance access, local GET/POST behavior with one instance unavailable, and recovery. This demonstrates process-level failover on one machine, not production high availability.

