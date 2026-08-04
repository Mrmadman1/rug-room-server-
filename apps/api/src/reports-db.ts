/**
 * Player-report storage on the shared `recflare` D1 database.
 *
 * Like the relationship table (and unlike the JSON-blob tables here — rooms /
 * accounts / image / invention), a report is genuinely columnar, so it gets a
 * normal relational table. Rows are append-only: nothing updates or dedupes a
 * report, so the table is a log of exactly what players submitted.
 *
 * The `api` worker owns this schema/migration (migrations/0004_report.sql,
 * applied under its own `migrations_table` so it doesn't clash with the other
 * workers' migrations that share the database).
 *
 * Nothing acts on the rows yet — `/api/PlayerReporting/v1/moderationBlockDetails`
 * still answers "not blocked" unconditionally; this is the record that a future
 * moderation flow would read.
 */

/** Schema DDL (mirror of migrations/0004_report.sql, sans seed rows). */
export const SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS report (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		reporter_player_id INTEGER NOT NULL,
		reported_player_id INTEGER NOT NULL,
		report_category INTEGER NOT NULL DEFAULT 0,
		details TEXT,
		height_reporter REAL,
		height_reported REAL,
		room_id INTEGER,
		room_instance_type TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_report_reported ON report (reported_player_id)`,
	`CREATE INDEX IF NOT EXISTS idx_report_reporter ON report (reporter_player_id)`,
]

/** A stored report row (snake_case columns, one row per submission). */
export interface ReportRow {
	id: number
	reporter_player_id: number
	reported_player_id: number
	report_category: number
	details: string | null
	/** Player height in metres, as the client measured it at report time. */
	height_reporter: number | null
	height_reported: number | null
	room_id: number | null
	/** The instance's `RoomInstanceType` name, e.g. `Public`. Stored verbatim. */
	room_instance_type: string | null
	created_at: string
}

/**
 * A report as submitted — everything but the reporter (which comes from the bearer
 * token) and the timestamp. Only the reported player is required; the client omits
 * fields it has no value for (a report raised outside a room carries no `RoomId`),
 * so the rest are optional and stored as NULL when absent.
 */
export interface NewReport {
	reporterPlayerId: number
	reportedPlayerId: number
	reportCategory?: number
	details?: string | null
	heightReporter?: number | null
	heightReported?: number | null
	roomId?: number | null
	roomInstanceType?: string | null
}

/** Record a submitted report, returning the stored row (with its assigned id). */
export async function createReport(db: D1Database, input: NewReport): Promise<ReportRow> {
	const row = await db
		.prepare(
			`INSERT INTO report (
				reporter_player_id, reported_player_id, report_category, details,
				height_reporter, height_reported, room_id, room_instance_type, created_at
			 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 RETURNING *`
		)
		.bind(
			input.reporterPlayerId,
			input.reportedPlayerId,
			input.reportCategory ?? 0,
			input.details ?? null,
			input.heightReporter ?? null,
			input.heightReported ?? null,
			input.roomId ?? null,
			input.roomInstanceType ?? null,
			new Date().toISOString()
		)
		.first<ReportRow>()
	// RETURNING always yields the inserted row; the non-null assert keeps the caller
	// from having to handle an impossible null.
	return row!
}

/** Every report filed against a player, newest first. Backs a future moderation view. */
export async function getReportsAgainst(db: D1Database, playerId: number): Promise<ReportRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM report WHERE reported_player_id = ?1 ORDER BY id DESC')
		.bind(playerId)
		.all<ReportRow>()
	return results
}
