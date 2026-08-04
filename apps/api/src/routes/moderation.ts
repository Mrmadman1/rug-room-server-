import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'

import { authedId, unauthorized } from '../http'
import {
	AUTHED,
	BareBoolean,
	CreateReportRequest,
	DeviceIdRequest,
	form,
	json,
	JsonArray,
	ModerationBlockDetails,
	ReportCreateResponse,
	UNAUTHORIZED_RESPONSE,
} from '../openapi'
import { createReport } from '../reports-db'

import type { Context } from 'hono'
import type { App } from '../context'

/**
 * Read one field of the report submission. The client posts it form-encoded, but the
 * same names also arrive as a query string on some builds, so both are accepted.
 */
function reportField(
	body: Record<string, unknown>,
	c: Context<App>,
	name: string
): string | undefined {
	const raw = body[name]
	if (typeof raw === 'string' && raw !== '') return raw
	return c.req.query(name) || undefined
}

/** Parse a field as an integer, or null when absent / not a number. */
const asInt = (v: string | undefined): number | null => {
	if (v === undefined) return null
	const n = Number.parseInt(v, 10)
	return Number.isNaN(n) ? null : n
}

/** Parse a field as a float (the reported heights), or null when absent / not a number. */
const asFloat = (v: string | undefined): number | null => {
	if (v === undefined) return null
	const n = Number.parseFloat(v)
	return Number.isNaN(n) ? null : n
}

// ---- Player reporting ------------------------------------------------------
export const moderationRoutes = new Hono<App>({ strict: false })
	// Whether the caller is currently blocked (banned / timed out / host-kicked). No
	// ban storage yet, so this is always the "not blocked" answer. `ReportCategory` is
	// -1 (no category) rather than 0, which is a real category; `Message` is null, not
	// an empty string — the client distinguishes "no message" from a blank one.
	.get(
		'/api/PlayerReporting/v1/moderationBlockDetails',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Whether the caller is blocked',
			description:
				'Ban / timeout / host-kick state for the caller. There is no ban storage yet, so ' +
				'this is always the “not blocked” answer. Two details matter to the client: ' +
				'`ReportCategory` is -1 (no category) rather than 0, which is a real category, and ' +
				'`Message` is null rather than an empty string — the client distinguishes “no ' +
				'message” from a blank one.',
			responses: { 200: json(ModerationBlockDetails, 'Always “not blocked”') },
		}),
		(c) =>
			c.json({
				ReportCategory: -1,
				Duration: 0,
				GameSessionId: 0,
				IsBan: false,
				IsHostKick: false,
				IsVoiceModAutoban: false,
				Message: null,
				PlayerIdReporter: null,
				TimeoutStartedAt: null,
			})
	)
	.get(
		'/api/PlayerReporting/v1/voteToKickReasons',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Vote-to-kick reasons',
			description:
				'The reasons offered when starting a vote-to-kick. Not hydrated yet, so the list ' +
				'is empty.',
			responses: { 200: json(JsonArray, 'An empty list') },
		}),
		(c) => c.json([])
	) // TODO: hydrate from JSON/vtkreasons.json
	.post(
		'/api/PlayerReporting/v1/hile',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Report submission sink',
			description:
				'A player report. Nothing stores reports, so this accepts whatever it is sent and ' +
				'answers a bare `false`.',
			responses: { 200: json(BareBoolean, 'A bare JSON `false`') },
		}),
		(c) => c.json(false)
	)

	// The report the client actually submits. Auth-gated: the reporter is taken from
	// the bearer token rather than the body, so a report can't be filed as someone else.
	.post(
		'/api/PlayerReporting/v3/create',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Submit a player report',
			description:
				'Records a player report in the `report` table — an append-only log; nothing ' +
				'dedupes or acts on the rows yet, and `moderationBlockDetails` still answers ' +
				'“not blocked” unconditionally.\n\n' +
				'The reporter is the caller (from the bearer token), NOT a body field. Only ' +
				'`PlayerIdReported` is required; the client omits whatever it has no value for ' +
				'(a report raised outside a room carries no `RoomId`), and those are stored as ' +
				'NULL. `ReportCategory` and `RoomInstanceType` are stored verbatim — neither ' +
				'enum is mapped here. A `RoomId` of 0 or below means “no room”.\n\n' +
				'Answers the real service’s `{ success, error }` envelope, where `error` is an ' +
				'empty string rather than null. The rejected branch uses the same envelope so ' +
				'the client only ever parses one shape.',
			security: AUTHED,
			requestBody: form(CreateReportRequest, 'The report'),
			responses: {
				200: json(ReportCreateResponse, '`{ success: true, error: "" }`'),
				400: json(ReportCreateResponse, 'No `PlayerIdReported` in the request'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const reporterId = await authedId(c)
			if (reporterId === null) return unauthorized(c)

			const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
			const reportedPlayerId = asInt(reportField(body, c, 'PlayerIdReported'))
			if (reportedPlayerId === null) {
				return c.json({ success: false, error: 'PlayerIdReported is required' }, 400)
			}

			// 0 / -1 are the client's "no room" values — store null rather than a bogus id.
			const roomId = asInt(reportField(body, c, 'RoomId'))

			await createReport(c.env.DB, {
				reporterPlayerId: reporterId,
				reportedPlayerId,
				reportCategory: asInt(reportField(body, c, 'ReportCategory')) ?? 0,
				details: reportField(body, c, 'Details') ?? null,
				heightReporter: asFloat(reportField(body, c, 'HeightReporter')),
				heightReported: asFloat(reportField(body, c, 'HeightReported')),
				roomId: roomId !== null && roomId > 0 ? roomId : null,
				roomInstanceType: reportField(body, c, 'RoomInstanceType') ?? null,
			})

			return c.json({ success: true, error: '' })
		}
	)

	// The client reporting its device id (form-encoded `oldDeviceId`, `newDeviceId`,
	// `platform`), rotating from the id it thinks we hold to the current one. Carries no
	// bearer token and fires before account creation, so there is no caller to attribute
	// the id to and nothing to store it against — we accept it and drop it. The real
	// service answers with a `{ success, error }` envelope.
	// @todo This doesn't do anything, in fact it breaks the client during account creation.
	// I have not been able to find a response shape that doesn't break, so in
	// https://github.com/djdevin/recnet-plugin we disable the device ID check to enable
	// account creation. Nothing in the logs, client just hangs, who knows what it is
	// waiting for.
	.post(
		'/api/PlayerReporting/v1/deviceId',
		describeRoute({
			tags: ['Moderation'],
			summary: 'Device id rotation (known broken)',
			description:
				'The client reporting its device id, rotating from the one it thinks we hold to ' +
				'the current one. It carries no bearer token and fires *before* account creation, ' +
				'so there is no caller to attribute the id to and nothing to store it against — ' +
				'we accept it and drop it.\n\n' +
				'**Known broken.** No response shape found so far keeps the client happy: it ' +
				'hangs during account creation with nothing in the logs. The real service answers ' +
				'a `{ success, error }` envelope; we currently answer an empty array, which does ' +
				'not help either. The workaround is to disable the device-id check client-side ' +
				'(see [recnet-plugin](https://github.com/djdevin/recnet-plugin)).',
			requestBody: form(DeviceIdRequest, 'The id rotation'),
			responses: {
				200: json(JsonArray, 'An empty array — see the note above; this is not the real shape'),
			},
		}),
		(c) => c.json([])
	)
