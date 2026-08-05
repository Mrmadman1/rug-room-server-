import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'

import { DOCUMENTED_SERVICES } from '../../docs'
import { DISCORD_INVITE, ISSUES_URL, PRIVACY_EMAIL } from '../../links'
import { turnstileKeys } from '../../turnstile'
import { postAuthForm, readAuthError } from '../../upstream'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

// Turnstile's documented always-passes test keypair, seeded into the LOCAL Secrets Store
// so the bindings resolve — the same way every other worker's tests seed JWT_SECRET. It
// stands in for the two account-level secrets a deployed www reads, and it's what OPENS
// signup (see src/turnstile.ts): without it every signup test would test the closed door.
const TEST_SITE_KEY = '1x00000000000000000000AA'
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'

beforeAll(async () => {
	await adminSecretsStore(env.TURNSTILE_SITE_KEY).create(TEST_SITE_KEY)
	await adminSecretsStore(env.TURNSTILE_SECRET_KEY).create(TEST_SECRET_KEY)
})

it('rejects unauthenticated account reads', async () => {
	const res = await SELF.fetch('https://example.com/api/me')
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

// Web signup is open, but only behind the Turnstile check. These pin the closed door:
// the pass path can't be tested here (it would call Cloudflare's siteverify for real).
it('advertises signup with the Turnstile site key the widget needs', async () => {
	const res = await SELF.fetch('https://example.com/api/config')
	expect(res.status).toBe(200)
	// Read through the Secrets Store binding, from the value seeded above.
	expect(await res.json()).toEqual({
		signupEnabled: true,
		turnstileSiteKey: TEST_SITE_KEY,
	})
})

// The keypair is the on/off switch for signup, so a www whose keys don't resolve must
// report it closed — that's the state a fresh deploy starts in, before the operator
// creates the two secrets. Checked directly because the real bindings are seeded for the
// fetch tests above.
//
// A store read that THROWS (secret absent, store unreachable) has to close the door the
// same way rather than surface as an error: /api/config is on the homepage's critical
// path, and a 500 there costs the whole page, not just the signup form.
it('treats an unresolvable or half-configured keypair as signup being off', async () => {
	const stub = (value: string | null): SecretsStoreSecret =>
		({ get: async () => value ?? '' }) as SecretsStoreSecret
	const throws = (): SecretsStoreSecret =>
		({
			get: async () => {
				throw new Error('secret not found')
			},
		}) as unknown as SecretsStoreSecret

	const withKeys = (site: SecretsStoreSecret, secret: SecretsStoreSecret) =>
		({
			ENVIRONMENT: 'development',
			TURNSTILE_SITE_KEY: site,
			TURNSTILE_SECRET_KEY: secret,
		}) as Env

	await expect(turnstileKeys(withKeys(throws(), throws()))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub('0xsite'), throws()))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(throws(), stub('0xsecret')))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub(''), stub('0xsecret')))).resolves.toBeNull()
	await expect(turnstileKeys(withKeys(stub('0xsite'), stub('0xsecret')))).resolves.toEqual({
		siteKey: '0xsite',
		secretKey: '0xsecret',
	})
})

it('refuses a signup with no Turnstile token', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: 'whatever' }),
	})
	// Rejected before any upstream call, so a bot can't reach create_account by omitting it.
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Please complete the bot check.' })
})

// The email is optional, but a malformed one is rejected BEFORE the account is created —
// the accounts worker would refuse to store it, and by then the account exists and the
// player would be left with an account whose email silently didn't save.
it('refuses a signup whose email could not be stored', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: 'whatever', email: 'not-an-address', turnstileToken: 'x' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'That email address looks wrong.' })
})

it('refuses a signup with no password', async () => {
	const res = await SELF.fetch('https://example.com/api/signup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ turnstileToken: 'dummy' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'A password is required.' })
})

// A refused grant reaches the form as a sentence, never as the OAuth code. auth answers
// `{ error: 'invalid_grant', error_description: <the actual reason> }`, and www used to
// relay that untouched — so every failed signup, including one the player could act on
// (the per-network cap), read simply "invalid_grant". Checked directly because the pass
// path can't be reached from here (it would call the real auth worker).
it('explains a refused signup instead of relaying invalid_grant', async () => {
	const refused = (description: string, status = 400) =>
		new Response(JSON.stringify({ error: 'invalid_grant', error_description: description }), {
			status,
			headers: { 'content-type': 'application/json' },
		})

	const capped = await readAuthError(
		refused('too many accounts created from this network'),
		'signup'
	)
	expect(capped.status).toBe(400)
	expect(capped.message).toContain('Too many accounts have already been created from your network')
	// The raw pair still reaches the operator's log line.
	expect(capped.upstream).toBe('invalid_grant: too many accounts created from this network')

	const badPassword = await readAuthError(refused('invalid account_id or password'), 'login')
	expect(badPassword.message).toBe('That username or password is incorrect.')

	// A description auth grew since this table was written must not leak through as-is:
	// it's written for an operator, so an unmapped one falls back to the generic sentence.
	const unmapped = await readAuthError(refused('some new internal reason'), 'signup')
	expect(unmapped.message).not.toContain('some new internal reason')
	expect(unmapped.message).toContain('could not be created')

	// Nothing about the form was wrong — auth couldn't proceed (an unset JWT_SECRET). Don't
	// send them back to re-check their details, and don't answer 400 for our own fault.
	const broken = await readAuthError(
		new Response(
			JSON.stringify({
				error: 'server_error',
				error_description: 'token signing is not configured',
			}),
			{ status: 500, headers: { 'content-type': 'application/json' } }
		),
		'signup'
	)
	expect(broken.status).toBe(502)
	expect(broken.message).toContain('problem on our end')

	// A body from something in front of auth (an edge error page) is not JSON at all.
	const html = await readAuthError(new Response('<html>502</html>', { status: 502 }), 'signup')
	expect(html.status).toBe(502)
	expect(html.message).toContain('problem on our end')
	expect(html.upstream).toBe('HTTP 502')
})

// The signup cap counts auth's `CF-Connecting-IP` as the account's immutable `signupIp`,
// and www used to reach auth over https://auth.<DOMAIN> — a Worker subrequest, which
// re-enters the Cloudflare edge, which REPLACES that header with Cloudflare's own
// address. Every browser signup therefore shared one IP, and the cap (3, never decaying)
// refused the fourth web account ever created, for everyone. The service binding skips
// the edge, so the header set here is the one auth reads.
//
// Checked directly rather than through /api/signup: the pass path would call Cloudflare's
// siteverify for real (see the Turnstile tests above).
it('carries the browser IP across to auth instead of losing it to the edge', async () => {
	const seen: Request[] = []
	const withAuth = (fetcher?: Fetcher) =>
		({
			DOMAIN: 'rec.example.com',
			AUTH: fetcher,
		}) as unknown as Env
	const capture = {
		fetch: async (request: Request) => {
			seen.push(request)
			return new Response('{}', { headers: { 'content-type': 'application/json' } })
		},
	} as unknown as Fetcher

	await postAuthForm(
		withAuth(capture),
		'/connect/token',
		{ grant_type: 'create_account', password: 'hunter2' },
		{ clientIp: '203.0.113.7' }
	)

	// The binding is used in preference to the hostname, and the real IP rides along.
	expect(seen).toHaveLength(1)
	expect(seen[0]!.headers.get('cf-connecting-ip')).toBe('203.0.113.7')
	// Still the same host/path/body auth already answers — only the transport changed.
	expect(seen[0]!.url).toBe('https://auth.rec.example.com/connect/token')
	const body = await seen[0]!.formData()
	expect(body.get('grant_type')).toBe('create_account')
	expect(body.get('password')).toBe('hunter2')

	// A call with no IP to forward must not invent one: an absent header leaves auth's
	// own `clientIp` empty, which SKIPS the cap, rather than counting everyone together.
	await postAuthForm(withAuth(capture), '/account/me/changepassword', {}, { bearer: 'tok' })
	expect(seen[1]!.headers.get('cf-connecting-ip')).toBeNull()
	expect(seen[1]!.headers.get('authorization')).toBe('Bearer tok')
})

it('requires credentials to log in', async () => {
	const res = await SELF.fetch('https://example.com/api/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: 'alice' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'Username and password are required.' })
})

it('rejects an unauthenticated username change', async () => {
	const res = await SELF.fetch('https://example.com/api/username', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: 'newname' }),
	})
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

// The accounts worker answers a refused username change at HTTP 200, in its own
// `{ success, error, value }` envelope — so an empty name reaching it would come back
// looking like a success to a browser that keys off the status. Rejected here instead,
// before the upstream call, and in the `{ error }` + 4xx shape every other endpoint uses.
it('refuses a username change with no username', async () => {
	const res = await SELF.fetch('https://example.com/api/username', {
		method: 'POST',
		// Any cookie value gets past the session check — www holds no signing key and
		// only forwards the token, so this stops at the empty-name check without ever
		// reaching accounts.
		headers: { 'content-type': 'application/json', cookie: 'rf_token=stub' },
		body: JSON.stringify({ username: '   ' }),
	})
	expect(res.status).toBe(400)
	expect(await res.json()).toEqual({ error: 'A username is required.' })
})

it('rejects an unauthenticated maintenance broadcast', async () => {
	const res = await SELF.fetch('https://example.com/api/maintenance', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ startsInMinutes: 15 }),
	})
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('rejects an unauthenticated coach message', async () => {
	const res = await SELF.fetch('https://example.com/api/coach-message', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ messageContent: 'hello all' }),
	})
	expect(res.status).toBe(401)
	expect(await res.json()).toEqual({ error: 'not signed in' })
})

it('serves the aggregated docs page with a source per documented service', async () => {
	const res = await SELF.fetch('https://example.com/docs')
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	// Mounts the self-hosted Scalar bundle (not a CDN) and lists every service's spec.
	expect(html).toContain('/docs/scalar.standalone.js')
	// Driven off the constant so adding a service can't leave the page (or this test)
	// behind.
	for (const { slug } of DOCUMENTED_SERVICES) {
		expect(html).toContain(`/docs/openapi/${slug}.json`)
	}
})

it('404s a spec proxy for an unknown service (not an open proxy)', async () => {
	// An un-allowlisted service is rejected before any upstream fetch, so this can't be
	// turned into a proxy to `https://<anything>.<DOMAIN>`.
	const res = await SELF.fetch('https://example.com/docs/openapi/evil.json')
	expect(res.status).toBe(404)
})

// The privacy policy is what the Meta Horizon Store's VRC.Privacy.1–4 checks are run
// against, and a reviewer only sees the rendered page — so the four things they look
// for are pinned here. If a section is renamed, re-read the VRC before loosening the
// assertion: these strings are the requirement, not incidental copy.
it('serves the privacy policy as real server-rendered HTML', async () => {
	const res = await SELF.fetch('https://example.com/privacy')
	// VRC.Privacy.1 — live, public, no sign-in, and text without JavaScript.
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('text/html')
	const html = await res.text()
	expect(html).toContain('Privacy Policy')

	// VRC.Privacy.2 — what is collected, VRC.Privacy.3 — what it is used for.
	expect(html).toContain('What we collect')
	expect(html).toContain('Why we use it')

	// VRC.Privacy.4 — deletion is explained, free, and open to every region.
	expect(html).toContain('Deleting your data')
	expect(html).toMatch(/delete your account[^.]*at any\s+time, from anywhere in the world/)
	expect(html).toContain('There is no charge for this')

	// A deletion route a reader can actually follow. Discord and GitHub are always
	// listed; the mailbox only when one is configured (see PRIVACY_EMAIL).
	expect(html).toContain(DISCORD_INVITE)
	expect(html).toContain(ISSUES_URL)
	if (PRIVACY_EMAIL) expect(html).toContain(`mailto:${PRIVACY_EMAIL}`)
})
