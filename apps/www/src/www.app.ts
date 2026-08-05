import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { useWorkersLogger } from 'workers-tagged-logger'

import { logger, withOnError } from '@repo/hono-helpers'

import { NotificationType } from '../../notify/src/notification-types'
import { docsPage, fetchSpec } from './docs'
import { privacyPage } from './privacy'
import { turnstileKeys, verifyTurnstile } from './turnstile'
import {
	accountsBase,
	apiBase,
	authUnreachable,
	imgBase,
	notifyBase,
	postAuthForm,
	postForm,
	putForm,
	readAuthError,
} from './upstream'

import type { Context } from 'hono'
import type { CookieOptions } from 'hono/utils/cookie'
import type { App } from './context'
import type { AuthAction } from './upstream'

/**
 * www — the first frontend worker. It serves the React SPA (create account, set
 * email, change password) and acts as a backend-for-frontend: the browser talks
 * only to www, and www forwards to the `auth`/`accounts` workers server-side (see
 * `upstream.ts`). The account's JWT lives in an httpOnly cookie set here, so it's
 * never exposed to page JS.
 */

/** Name of the httpOnly session cookie holding the account's access token. */
const SESSION_COOKIE = 'rf_token'

/**
 * RecNet (4) is the web platform, stamped as the token's `platform` claim on login.
 * NOT passed on signup: create_account treats an asserted platform as one to verify
 * against Steam and rejects RecNet — the web signup is the (platform-less) password
 * account path.
 */
const WEB_PLATFORM = '4'

/**
 * Roles that unlock the admin controls in the UI. Mirrors the notify worker's
 * `ADMIN_ROLES` gate — www only decides whether to *show* the controls; notify does
 * the real enforcement (it verifies the token) on every call.
 */
const ADMIN_ROLES = new Set(['developer', 'moderator'])

/** Cookie flags for the session token. `secure` is dropped for local http dev. */
function sessionCookieOptions(c: Context<App>, maxAge: number): CookieOptions {
	const local = c.env.ENVIRONMENT === 'development' || c.env.ENVIRONMENT === 'VITEST'
	return {
		httpOnly: true,
		secure: !local,
		sameSite: 'Lax',
		path: '/',
		maxAge,
	}
}

/** Pull the session token out of the request cookie, or null when absent. */
function sessionToken(c: Context<App>): string | null {
	return getCookie(c, SESSION_COOKIE) ?? null
}

/**
 * Whether the session token carries an admin role. Decodes the JWT's `role` claim
 * WITHOUT verifying — www holds no signing key, and this only gates whether admin UI
 * is shown; the notify worker verifies the token before acting on it. A malformed
 * token simply reads as "not admin".
 */
function isAdminToken(token: string): boolean {
	const payload = token.split('.')[1]
	if (!payload) return false
	try {
		const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
		const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
		const claims = JSON.parse(atob(padded)) as { role?: unknown }
		return Array.isArray(claims.role) && claims.role.some((r) => ADMIN_ROLES.has(r as string))
	} catch {
		return false
	}
}

/** Relay an upstream worker's JSON response back to the browser unchanged. */
async function relay(c: Context<App>, res: Response) {
	const body = await res.text()
	return c.body(body, res.status as never, {
		'content-type': res.headers.get('content-type') ?? 'application/json',
	})
}

/**
 * Exchange an auth `/connect/token` response for a session: persist the returned
 * access token in the httpOnly cookie, then return the caller's self account
 * (fetched from the accounts worker with the fresh token).
 *
 * `email`, when given, is saved onto the new account before that fetch, so the account
 * comes back already carrying it. `create_account` takes no email — the accounts worker
 * owns that field — which is why this is a second call rather than another grant field.
 *
 * A refused grant is translated (see `readAuthError`) rather than relayed: auth answers
 * the OAuth shape, whose `error` is always a code like `invalid_grant`, and that code is
 * what the form used to show for every failure — including the per-network signup cap,
 * which the player could otherwise understand. The raw pair is logged for the operator.
 */
async function establishSession(
	c: Context<App>,
	action: AuthAction,
	tokenResponse: Response,
	email?: string
) {
	if (!tokenResponse.ok) {
		const failure = await readAuthError(tokenResponse, action)
		logger.info('auth refused a token grant', {
			action,
			status: tokenResponse.status,
			upstream: failure.upstream,
		})
		return c.json({ error: failure.message }, failure.status)
	}

	const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number }
	if (!token.access_token) {
		logger.error('auth answered a token grant with no access_token', { action })
		return c.json({ error: authUnreachable(action) }, 502)
	}

	setCookie(
		c,
		SESSION_COOKIE,
		token.access_token,
		sessionCookieOptions(c, token.expires_in ?? 3600)
	)

	// Deliberately not fatal: the account exists and the session is live by now, so failing
	// the request would leave the player holding an account they think they don't have —
	// and a retry would burn another slot against auth's per-IP signup cap. They land on
	// the account page instead, where the email field is the same one call away. The
	// address is validated before signup starts, so reaching here means something upstream
	// went wrong, not that the input was bad.
	if (email) {
		const res = await postForm(
			`${accountsBase(c.env)}/account/me/email`,
			{ email },
			token.access_token
		)
		if (!res.ok) {
			logger.error('failed to save the signup email; the account was still created', {
				status: res.status,
			})
		}
	}

	const me = await fetch(`${accountsBase(c.env)}/account/me`, {
		headers: { authorization: `Bearer ${token.access_token}` },
	})
	// The session cookie is already set, so this is the one failure where telling them to
	// retry would be wrong: on signup the account exists (and a second attempt spends
	// another slot against auth's per-IP cap), and either way a reload finds them signed in.
	if (!me.ok) {
		logger.error('failed to load the account after a token grant', { action, status: me.status })
		return c.json(
			{
				error:
					action === 'signup'
						? 'Your account was created, but loading it failed. Reload the page — you are already signed in.'
						: 'You are signed in, but loading your account failed. Please reload the page.',
			},
			502
		)
	}
	const account = (await me.json()) as Record<string, unknown>
	return c.json({ account: { ...account, isAdmin: isAdminToken(token.access_token) } })
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())

	// ---- BFF API ------------------------------------------------------------

	// What the SPA has to know before it can render the sign-in page: whether web signup
	// is open, and the Turnstile site key to mount its widget with. The site key is public
	// (it ships in the widget markup either way); the secret never leaves the worker.
	// Served rather than baked into the client build so one build works for any operator.
	.get('/api/config', async (c) => {
		const keys = await turnstileKeys(c.env)
		return c.json({ signupEnabled: keys !== null, turnstileSiteKey: keys?.siteKey ?? null })
	})

	// Create an account from the website, behind a Turnstile bot check. The check is what
	// makes this safe to leave open: `auth` binds no platform identity to a web account, so
	// its per-IP cap is the only other thing in front of this path.
	//
	// Deliberately passes NO `platform`: create_account treats an asserted platform as one
	// to verify against Steam and would reject RecNet (see WEB_PLATFORM), so this is the
	// platform-less password-account path. The username is auto-assigned by auth — players
	// don't pick one — and the new session is established from the token response.
	.post('/api/signup', async (c) => {
		// No usable keypair means signup is closed rather than unprotected (see turnstile.ts).
		const keys = await turnstileKeys(c.env)
		if (!keys) return c.json({ error: 'Account creation is currently disabled.' }, 403)

		type SignupBody = { password?: string; email?: string; turnstileToken?: string }
		const { password, email, turnstileToken } = await c.req
			.json<SignupBody>()
			.catch(() => ({}) as SignupBody)
		if (!password) return c.json({ error: 'A password is required.' }, 400)
		if (!turnstileToken) return c.json({ error: 'Please complete the bot check.' }, 400)

		// Optional — an account works without one; it's the address a locked-out player
		// would be reached at. Checked HERE, before anything is created, because the
		// accounts worker rejects an address with no `@` and by then the account exists:
		// better to fail the form than to hand back an account whose email silently didn't
		// save. Same rule the accounts worker applies, deliberately no stricter — this is
		// a contact address, not an identity, and nothing is sent to it to prove it.
		const signupEmail = typeof email === 'string' ? email.trim() : ''
		if (signupEmail !== '' && !signupEmail.includes('@')) {
			return c.json({ error: 'That email address looks wrong.' }, 400)
		}

		// The IP Turnstile cross-checks the token against — set by the edge, so the client
		// can't spoof it (unlike X-Forwarded-For). `auth` records the same header as the
		// account's signup IP, which is why it's forwarded to the grant below rather than
		// left to the edge: see `postAuthForm`.
		const clientIp = c.req.header('cf-connecting-ip')
		const verified = await verifyTurnstile(keys.secretKey, turnstileToken, clientIp)
		// A token is single-use, so the client resets its widget before letting them retry.
		if (!verified) return c.json({ error: 'Bot check failed. Please try again.' }, 403)

		// A throw here is auth being unreachable, not a rejected signup — answered as such
		// rather than falling through to the generic 500 handler, whose "internal server
		// error" tells the player nothing about whether they now have an account (they don't:
		// nothing was created).
		const res = await postAuthForm(
			c.env,
			'/connect/token',
			{ grant_type: 'create_account', password },
			{ clientIp }
		).catch(() => null)
		if (res === null) {
			logger.error('could not reach auth to create an account')
			return c.json({ error: authUnreachable('signup') }, 502)
		}
		return establishSession(c, 'signup', res, signupEmail || undefined)
	})

	// Log in with a username + password, then start a session. The auth password grant
	// resolves the account by `username` (case-insensitive) — web players sign in with
	// their username, not the numeric account id.
	.post('/api/login', async (c) => {
		const { username, password } = await c.req
			.json<{ username?: string; password?: string }>()
			.catch(() => ({}) as { username?: string; password?: string })
		if (!username || !password) {
			return c.json({ error: 'Username and password are required.' }, 400)
		}

		// The IP goes along here too: auth refreshes `lastLoginIp` on every successful
		// grant, and without it every web login would stamp the same Cloudflare address.
		const res = await postAuthForm(
			c.env,
			'/connect/token',
			{ grant_type: 'password', username, platform: WEB_PLATFORM, password },
			{ clientIp: c.req.header('cf-connecting-ip') }
		).catch(() => null)
		if (res === null) {
			logger.error('could not reach auth to sign in')
			return c.json({ error: authUnreachable('login') }, 502)
		}
		return establishSession(c, 'login', res)
	})

	// Clear the session cookie.
	.post('/api/logout', (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: '/' })
		return c.json({ success: true })
	})

	// Public homepage slideshow. Proxies the api worker's (public) slideshow feed and
	// projects each image to a full img.<domain> URL the browser can load directly, so
	// the page JS never has to know the upstream hosts. No session required.
	.get('/api/slideshow', async (c) => {
		const res = await fetch(`${apiBase(c.env)}/api/images/v1/slideshow`)
		if (!res.ok) return relay(c, res)
		const data = (await res.json()) as {
			Images?: Array<{ ImageName: string; Username: string; RoomName: string | null }>
			ValidTill?: string
		}
		const images = (data.Images ?? []).map((i) => ({
			url: `${imgBase(c.env)}/${i.ImageName}`,
			username: i.Username,
			roomName: i.RoomName,
		}))
		return c.json({ images, validTill: data.ValidTill ?? null })
	})

	// Current session's self account (used to restore UI state on page load).
	.get('/api/me', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const res = await fetch(`${accountsBase(c.env)}/account/me`, {
			headers: { authorization: `Bearer ${token}` },
		})
		// Token expired/invalid — drop the stale cookie so the client shows sign-in.
		if (res.status === 401) {
			deleteCookie(c, SESSION_COOKIE, { path: '/' })
			return c.json({ error: 'session expired' }, 401)
		}
		if (!res.ok) return relay(c, res)
		// Augment the self account with whether this session may use admin controls,
		// read from the token's role claim (see isAdminToken).
		const account = (await res.json()) as Record<string, unknown>
		return c.json({ ...account, isAdmin: isAdminToken(token) })
	})

	// Change the signed-in account's username.
	//
	// The accounts worker answers this one in its own envelope — `{ success, error, value }`
	// at HTTP 200 even when it refused (taken name, no changes left) — so relaying it
	// verbatim would read as a success to the browser, which keys off the status. It's
	// translated to the same `{ error }` + 4xx shape as every other endpoint here instead;
	// the sentences accounts writes are already player-facing, so they pass through as-is.
	//
	// On success the caller's SELF account is re-fetched rather than returning the
	// envelope's `value`: that's the PUBLIC DTO, and it carries no
	// `availableUsernameChanges` — the very field the form needs to know whether another
	// change is left. (An account starts with one; it's spent by this call.)
	.post('/api/username', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { username } = await c.req
			.json<{ username?: string }>()
			.catch(() => ({}) as { username?: string })
		const wanted = typeof username === 'string' ? username.trim() : ''
		if (wanted === '') return c.json({ error: 'A username is required.' }, 400)

		const res = await putForm(
			`${accountsBase(c.env)}/account/me/username`,
			{ username: wanted },
			token
		)
		if (!res.ok) return relay(c, res)

		const result = (await res.json().catch(() => null)) as {
			success?: boolean
			error?: unknown
		} | null
		if (!result) {
			logger.error('accounts answered a username change with a body that was not JSON')
			return c.json({ error: 'Your username could not be changed. Please try again later.' }, 502)
		}
		const refusal = typeof result.error === 'string' ? result.error : ''
		if (refusal !== '') return c.json({ error: refusal }, 400)

		const me = await fetch(`${accountsBase(c.env)}/account/me`, {
			headers: { authorization: `Bearer ${token}` },
		})
		// The name has already changed by now, so this can't be reported as a failure —
		// telling them to retry would spend the change they no longer have. A reload shows
		// the new name either way.
		if (!me.ok) {
			logger.error('failed to reload the account after a username change', { status: me.status })
			return c.json(
				{ error: 'Your username was changed, but reloading your account failed. Reload the page.' },
				502
			)
		}
		const account = (await me.json()) as Record<string, unknown>
		return c.json({ ...account, isAdmin: isAdminToken(token) })
	})

	// Set the signed-in account's email.
	.post('/api/email', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { email } = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string })
		if (!email) return c.json({ error: 'An email is required.' }, 400)

		const res = await postForm(`${accountsBase(c.env)}/account/me/email`, { email }, token)
		return relay(c, res)
	})

	// Change the signed-in account's password (current password required).
	.post('/api/password', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { oldPassword, newPassword } = await c.req
			.json<{ oldPassword?: string; newPassword?: string }>()
			.catch(() => ({}) as { oldPassword?: string; newPassword?: string })
		if (!newPassword) return c.json({ error: 'A new password is required.' }, 400)

		// No `clientIp`: auth reads no IP on this path — it's routed through the binding
		// only so every auth call goes one way.
		const res = await postAuthForm(
			c.env,
			'/account/me/changepassword',
			{ oldPassword: oldPassword ?? '', newPassword },
			{ bearer: token }
		)
		return relay(c, res)
	})

	// Broadcast a ServerMaintenance countdown to every connected client. Forwards the
	// session token to the notify worker, which enforces the admin-role gate — so a
	// non-admin session is rejected upstream (403) even though www shows no button.
	// The notification frame carries `Msg: { StartsInMinutes }`, matching the client's
	// ServerMaintenance handler; the response mirrors the reference maintenance API.
	.post('/api/maintenance', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { startsInMinutes } = await c.req
			.json<{ startsInMinutes?: number }>()
			.catch(() => ({}) as { startsInMinutes?: number })
		const minutes = Number(startsInMinutes)
		const startsIn = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0

		const res = await fetch(`${notifyBase(c.env)}/internal/broadcast`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				notificationType: NotificationType.ServerMaintenance,
				data: { StartsInMinutes: startsIn },
			}),
		})
		if (!res.ok) return relay(c, res)

		const result = (await res.json()) as { delivered?: number }
		return c.json({
			success: true,
			starts_in_minutes: startsIn,
			connections: result.delivered ?? 0,
		})
	})

	// Send a coach/system message to every online player. Like maintenance, this
	// forwards the session token to notify, which enforces the admin-role gate.
	.post('/api/coach-message', async (c) => {
		const token = sessionToken(c)
		if (!token) return c.json({ error: 'not signed in' }, 401)

		const { messageContent } = await c.req
			.json<{ messageContent?: string }>()
			.catch(() => ({}) as { messageContent?: string })
		const content = typeof messageContent === 'string' ? messageContent.trim() : ''
		if (content === '') return c.json({ error: 'A message is required.' }, 400)

		const res = await fetch(`${notifyBase(c.env)}/internal/coach-message-all`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ messageContent: content }),
		})
		if (!res.ok) return relay(c, res)

		const result = (await res.json()) as { sent?: number }
		return c.json({ success: true, sent: result.sent ?? 0 })
	})

	// ---- Privacy policy -----------------------------------------------------
	// Server-rendered rather than a SPA route so the page has real text without
	// JavaScript: the Meta Horizon Store re-fetches this URL to check the policy is
	// still live, and an empty SPA shell can read as a broken link (see privacy.ts).
	.get('/privacy', (c) => c.html(privacyPage()))

	// ---- Aggregated API docs ------------------------------------------------
	// `/docs` serves the self-hosted Scalar UI; `/docs/openapi/:service.json` proxies
	// each worker's spec same-origin (see docs.ts). The Scalar bundle itself
	// (`/docs/scalar.standalone.js`) is a static asset emitted by the vite build, so it
	// falls through to the ASSETS catch-all below.
	.get('/docs', (c) => c.html(docsPage()))
	.get('/docs/openapi/:service', async (c) => {
		// Scalar requests `auth.json`; strip the suffix to get the service slug. The
		// param is a single path segment, and fetchSpec allowlists it (so this can't be
		// coerced into an open proxy).
		const slug = c.req.param('service').replace(/\.json$/, '')
		const spec = await fetchSpec(c.env, slug)
		if (spec === null) return c.notFound()
		return spec
	})

	// ---- Static SPA ---------------------------------------------------------
	// Everything else is served from the built client assets. With
	// `not_found_handling: single-page-application`, unknown routes return
	// index.html so the React app can handle client-side routing.
	.all('*', (c) => {
		if (!c.env.ASSETS) return c.notFound()
		return c.env.ASSETS.fetch(c.req.raw)
	})

export default app
