import type { Env } from './context'

/**
 * The www worker is a backend-for-frontend (BFF): the browser only ever talks to
 * www, and www forwards to the `auth` and `accounts` workers server-side. That
 * keeps the JWT off other origins and sidesteps CORS (those workers set no CORS
 * headers). Hosts are derived from the shared base domain (`auth.<DOMAIN>`,
 * `accounts.<DOMAIN>`), matching how the workers are deployed.
 */

export const authBase = (env: Env): string => `https://auth.${env.DOMAIN}`
export const accountsBase = (env: Env): string => `https://accounts.${env.DOMAIN}`
export const notifyBase = (env: Env): string => `https://notify.${env.DOMAIN}`
export const apiBase = (env: Env): string => `https://api.${env.DOMAIN}`
export const imgBase = (env: Env): string => `https://img.${env.DOMAIN}`

/**
 * Send a form-urlencoded body to an upstream worker. The auth/accounts endpoints
 * read their inputs via Hono's `parseBody()`, so they expect form fields (not
 * JSON). `bearer`, when given, authenticates the caller.
 */
async function sendForm(
	method: 'POST' | 'PUT',
	url: string,
	fields: Record<string, string>,
	bearer?: string
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
	}
	if (bearer) headers.authorization = `Bearer ${bearer}`
	return fetch(url, {
		method,
		headers,
		body: new URLSearchParams(fields).toString(),
	})
}

/** POST a form-urlencoded body to an upstream worker (see `sendForm`). */
export const postForm = (
	url: string,
	fields: Record<string, string>,
	bearer?: string
): Promise<Response> => sendForm('POST', url, fields, bearer)

/**
 * PUT a form-urlencoded body to an upstream worker (see `sendForm`). The accounts
 * worker's profile mutations are split by verb — the username change is a PUT, and
 * posting to it 404s rather than failing loudly.
 */
export const putForm = (
	url: string,
	fields: Record<string, string>,
	bearer?: string
): Promise<Response> => sendForm('PUT', url, fields, bearer)

/**
 * POST a form body to the `auth` worker, carrying the browser's real IP across.
 *
 * Every other upstream is reached over its public hostname, but auth can't be: it reads
 * the caller's address from `CF-Connecting-IP` and counts it as the account's immutable
 * `signupIp`, and a Worker subrequest to https://auth.<DOMAIN> re-enters the Cloudflare
 * edge, which REPLACES that header with Cloudflare's own address. Every web signup
 * therefore recorded one shared IP, and auth's per-IP cap — 3 accounts, never decaying —
 * refused the fourth web account ever created, for everybody. The web path asserts no
 * platform, so that arm was also the only cap actually in front of it.
 *
 * Going through the service binding skips the edge, so the header set here is the one
 * auth reads. That is safe precisely because the edge does overwrite it on the public
 * route: a game client posting `/connect/token` directly still cannot spoof its own IP,
 * so no shared secret is needed to tell the two callers apart.
 *
 * `clientIp` is the caller's own edge-set `cf-connecting-ip`, and must never be anything
 * a browser supplied. Omit it on calls that aren't IP-sensitive.
 *
 * Falls back to the public hostname when the binding is absent (local `vite dev` — see
 * `Env.AUTH`); the edge then overwrites the header again, which is the old behaviour.
 */
export async function postAuthForm(
	env: Env,
	path: string,
	fields: Record<string, string>,
	opts: { bearer?: string; clientIp?: string } = {}
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
	}
	if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
	if (opts.clientIp) headers['cf-connecting-ip'] = opts.clientIp

	const request = new Request(`${authBase(env)}${path}`, {
		method: 'POST',
		headers,
		body: new URLSearchParams(fields).toString(),
	})
	return env.AUTH ? env.AUTH.fetch(request) : fetch(request)
}

/** Which grant www was making, so a shared refusal reads right on either form. */
export type AuthAction = 'signup' | 'login'

/** A rejected `/connect/token` grant, translated for the browser. */
export interface AuthFailure {
	/** The sentence to put in front of the player. */
	message: string
	/** 400 when the grant was refused, 502 when `auth` itself couldn't proceed. */
	status: 400 | 502
	/** The raw `error`/`error_description` pair, for the operator's log line only. */
	upstream: string
}

/**
 * What each of auth's `error_description`s means to somebody filling in a form.
 *
 * Keyed on the exact string auth sends (see its `/connect/token` handler). Only a few
 * are reachable from the web — signup posts `create_account` with no platform, login
 * posts `password` with no `platform_auth` — but the platform arms are mapped anyway so
 * a future web flow that does assert one can't regress to a bare code.
 */
const AUTH_MESSAGES: Record<string, string> = {
	'too many accounts created from this network':
		'Too many accounts have already been created from your network. Try again later, or from a different connection.',
	'account limit reached for this platform account':
		'This platform account has already created as many accounts as it is allowed.',
	'invalid account_id or password': 'That username or password is incorrect.',
	'account_id or username is required': 'Username and password are required.',
	'invalid or missing platform_auth': 'Your platform sign-in could not be verified.',
	'unsupported platform; only Steam and Meta can be verified':
		'That platform cannot be verified — only Steam and Meta are supported.',
	'no linked account for this platform identity':
		'No account is linked to this platform sign-in yet. Sign in with your password once to link it.',
	'refresh_token is invalid or expired': 'Your session has expired. Please sign in again.',
}

/** Fallbacks when nothing above matched, so a player never reads an OAuth code. */
const GENERIC_MESSAGES: Record<AuthAction, { rejected: string; broken: string }> = {
	signup: {
		rejected: 'Your account could not be created. Please check your details and try again.',
		broken:
			'Accounts cannot be created right now. This is a problem on our end — please try again later.',
	},
	login: {
		rejected: 'You could not be signed in. Please check your details and try again.',
		broken:
			'Sign-in is unavailable right now. This is a problem on our end — please try again later.',
	},
}

/** Message for an `auth` that couldn't be reached at all (the fetch itself threw). */
export const authUnreachable = (action: AuthAction): string => GENERIC_MESSAGES[action].broken

/**
 * Read a failed `auth` `/connect/token` response into something worth showing.
 *
 * auth answers the OAuth shape — `{ error: 'invalid_grant', error_description: … }` —
 * where `error` is one of three machine codes and the DESCRIPTION carries the actual
 * reason. Relaying that body verbatim put "invalid_grant" on screen for every failure,
 * including the ones a player can act on (the per-network signup cap), so the
 * description is matched to a sentence here instead. An unrecognised body — or a
 * non-JSON one from something in front of auth — falls back to the generic line for
 * the action rather than leaking whatever it did say.
 */
export async function readAuthError(res: Response, action: AuthAction): Promise<AuthFailure> {
	const parsed = (await res.json().catch(() => null)) as {
		error?: unknown
		error_description?: unknown
	} | null
	const body = parsed ?? {}
	const code = typeof body.error === 'string' ? body.error : ''
	const description = typeof body.error_description === 'string' ? body.error_description : ''

	// A 5xx (or a `server_error`) is an operator misconfiguration — an unset JWT_SECRET,
	// an unset META_APP_SECRET — not something the player got wrong. Don't send them back
	// to re-check a form that was fine; the real reason is in auth's log, not theirs.
	const broken = res.status >= 500 || code === 'server_error'
	const generic = GENERIC_MESSAGES[action]

	return {
		message:
			(!broken && AUTH_MESSAGES[description]) || (broken ? generic.broken : generic.rejected),
		status: broken ? 502 : 400,
		upstream: description ? `${code || 'unknown'}: ${description}` : code || `HTTP ${res.status}`,
	}
}
