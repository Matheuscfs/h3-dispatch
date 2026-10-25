# Design: dispatch as a service

The simulator runs in one process. This document sketches how the same ideas would be split into services for a real city, and where they would break first. It is the answer I would give to "design the matching system for a ride-hailing app".

## Requirements

**Functional**

- Drivers send their location every few seconds while online.
- A rider requests a trip; the system offers it to the best nearby driver, and to the next one if the first declines or times out.
- Prices reflect local demand and supply, updated every minute or so.

**Non-functional (a mid-size country)**

- 500k drivers online at peak, one location update every 4 s: **~125k writes/s**.
- 20k trip requests per minute at peak: **~350 matches/s**, each needing a nearest-driver query.
- Match latency under 200 ms at p99, excluding the time the driver takes to accept.
- A driver must never be offered two trips at once.

## Components

```
 driver app ──► Location ingest ──► stream (partitioned by H3 res-5 cell) ──► Geo index shards
                                                       │
                                                       └──► Surge aggregator ──► price cache
 rider app ───► Trip service ──► Matcher ──► Geo index shards (nearest idle drivers)
                                     │
                                     └──► Offer service (locks the driver, pushes the offer, handles timeout)
```

- **Location ingest.** Stateless; validates updates, drops out-of-order ones (timestamp per driver) and publishes them to a stream partitioned by a coarse H3 cell, so one city area always lands on the same partition.
- **Geo index shards.** Each shard owns a set of coarse cells and keeps `DriverIndex` in memory for them, at a fine resolution (8 or 9) chosen per city by driver density. In-memory is right here: positions are worthless after a few seconds, so losing a shard means waiting one update cycle, not losing data.
- **Matcher.** Converts the pickup to a cell, asks the owning shard for the k nearest idle drivers, re-ranks them by road ETA from a routing service, and hands the best to the offer service.
- **Offer service.** Takes a short lease on the driver (compare-and-set on driver state, e.g. in Redis with a TTL), so concurrent matchers cannot offer the same driver twice. On decline or timeout it releases the lease and asks for the next candidate.
- **Surge aggregator.** Consumes requests and driver states from the stream, counts them per fine cell over a sliding window, applies the smoothing from `surge.ts`, and publishes multipliers to a cache the trip service reads when quoting.

## Where it breaks first, and what to do

| Problem | Why | Mitigation |
|---|---|---|
| **Queries near shard edges** | The ring search crosses into cells owned by another shard. | Shards also hold a halo: drivers within a few rings outside their area. Updates for halo cells are published to both owners. The bound in `ringLowerBoundM` says how many rings the halo needs for a given maximum pickup distance. |
| **Hot cells** | A stadium or airport puts thousands of drivers and requests in a few cells. | Use a finer resolution there (H3 cells nest), or split the hot coarse cell across shard replicas. |
| **Resolution choice** | Coarse cells degrade to a linear scan; fine cells waste lookups on empty cells (see the benchmark in the README). | Pick the resolution per city from driver density, and revisit it as the city grows. |
| **Write volume** | 125k updates/s. | Most updates do not change cell; shards apply them as an in-place position change. Only cell changes touch the bucket structure. |
| **Stale positions** | A driver loses signal. | Evict drivers with no update for N seconds; never offer a trip to a driver whose last update is older than the threshold. |
| **Double offers** | Two matchers pick the same driver at the same time. | The lease in the offer service is the single source of truth; the geo index is only a candidate generator. |
| **Greedy matching** | Nearest-first is locally optimal but globally poor at peaks. | Batch requests for 2 to 5 s per area and solve an assignment problem (Hungarian algorithm or min-cost flow) over the candidate lists. |

## Why hexagons

- Every neighbour of a hexagon is the same distance away, and there are no corner neighbours (unlike squares, which have two kinds). Rings are clean, which is what makes the stopping rule simple.
- Hexagons approximate circles better than squares, so "everything within ring r" is a decent proxy for "everything within a radius".
- H3 is hierarchical: a coarse cell for sharding and a fine cell for indexing come from the same coordinates, with no extra lookup.
- Neighbour averaging (used for surge smoothing) treats all six neighbours equally.

## What the simulator covers and what it does not

Covered: the index, the ring search and its stopping rule, surge with spatial smoothing, a dispatch loop and its metrics, all deterministic and tested.

Not covered: sharding and halos, leases and offer timeouts, road-network ETAs, batched assignment. Each could be a next step on top of the same core.
