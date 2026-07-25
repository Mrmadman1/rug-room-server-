# cdn

CDN Worker served on the `cdn` subdomain (`cdn.recflare.net`) — a Hono app that streams
the binary blobs the client downloads while playing out of the shared `recflare-cdn` R2
bucket, plus the one bundled config file the loading screen reads.

Objects are keyed by prefix — `sigs/` (anti-cheat signatures), `room/` (saved room
scenes, and room images by their bare `ImageName`), `invention/` (invention data) — and
served as `application/octet-stream`; the worker never interprets what it hands back.
Reads are unauthenticated: a caller needs the exact key, which only comes from an
authenticated call to another worker.

This worker only reads. Uploads go through `storage`, which writes the same bucket, and
images are served by `img`.

## API documentation

`GET /openapi.json` serves a spec generated from `describeRoute` blocks that sit
alongside each handler, with the schemas in `src/openapi.ts`. It's also aggregated into
the docs page www serves at `/docs`.

**The spec is descriptive, not enforced** — same rationale as the `img`/`auth` workers: a
reverse-engineered protocol, lenient handlers, no runtime validation. A test asserts
every route appears in the spec, so adding one without documenting it fails.

## Conditional and range requests

Every asset route honours `If-None-Match` (→ 304) and a single `Range` (→ 206). The range
support is not an optimization: large-file downloaders fetch in chunks, and answering 200
where a 206 is expected corrupts the reassembled file — which surfaces as an anti-cheat
"Signatures don't match" failure rather than a download error.

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

### Deploy

```sh
pnpm turbo deploy
```
