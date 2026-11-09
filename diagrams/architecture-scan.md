# Architecture snapshot and V5 pause checkpoint

Snapshot: 7 November 2026. V5 implementation is paused at the user's request. This document records the existing state; it does not mark analytics complete.

## Files

- application-architecture.png: high-level diagram for viewing.
- application-architecture.svg: self-contained vector diagram with embedded logos.
- application-architecture.mmd: editable Mermaid topology.

## Scan scope and checks

Inspected server.js, routes, services, repository, connection configs, timeout helper, publisher draft, Nginx config, and the project file inventory. Did not read .env values. Read container names, images, published ports, volume mounts, startup arguments, and running state only.

Both application health endpoints (8000 and 8001) and Nginx (8080) returned 200. Nginx, cache Redis, and queue Redis containers were running. These were read-only checks; no instance was stopped and no test event was published.

## Implemented application

- Nginx container publishes 127.0.0.1:8080 to its port 80. Its upstream group targets host.docker.internal ports 8000 and 8001.
- Node.js/Express applications run on the host. PORT selects the listener; current code falls back to 8888.
- Both instances use the same MySQL mappings and cache Redis, but have separate clients, pools, and process-local cooldown values.
- POST /links validates HTTPS input, stores a candidate code with up to five collision attempts, and returns BASE_URL plus code.
- GET /:code resolves through cache-aside and returns a 302 Location or 404. The browser then requests the destination website.
- Cache client uses a queue limit of 100 and disabled offline queueing. Cache reads/writes use the extracted 500 ms waiting helper; failures trigger a five-second local cooldown. Cached mappings expire after 300 seconds.
- MySQL startup check is awaited. Cache and queue Redis connections are started in the background.

## V5: prepared, but not integrated

- config/queueRedis.js creates a separate Redis client. server.js connects it at startup. It uses disabled offline queueing and a queue limit of 100.
- Queue container publishes host port 6380 to internal port 6379. AOF is enabled, and the named volume url-shortener-queue-data is mounted at /data.
- queues/clickQueue.js contains a draft publisher intended to use XADD on analytics:clicks with the shared timeout helper.
- The redirect route does NOT import or call the publisher. Therefore current redirects do not generate analytics events through this code path.
- There is no worker implementation in the file inventory, and no implemented consumer group or ACK path was found.
- Analytics storage schema has not been implemented in the inspected repository. Database schemas were not queried during this scan.
- Stream name in the diagram is the intended stream, not a claim that a stream already exists in Redis.

## Resume checklist: do not implement until requested

1. Fix the publisher's missing .js extensions in its relative imports.
2. Replace imported node:console error usage and new error(...) with the normal Error constructor; the imported logger is not the intended exception type.
3. Standardize occured_at to the planned occurred_at field name.
4. Verify the draft publisher independently, then wire it after a successful URL lookup with bounded waiting and failure handling that preserves redirects.
5. Define MySQL analytics storage with a unique event_id.
6. Implement consumer group, worker persistence, ACK after successful save, duplicate handling, and pending-event recovery.

These findings are recorded only; application code was not changed. A publishing timeout does not guarantee the event was not written: the underlying Redis operation can complete later. Future retries must preserve event identity. AOF and a volume improve persistence but do not guarantee zero data loss.

## Diagram conventions

Solid blue/teal lines show implemented application communication or startup connections. Dashed amber lines show unfinished V5 event processing. Worker and analytics boxes are planned components, not running services. All components remain on one computer; this is not machine-level high availability.

Logos: Devicon project (https://github.com/devicons/devicon), fetched from its public icon SVGs for nginx, nodejs, express, mysql, redis, and docker. The SVG embeds them for offline viewing.
