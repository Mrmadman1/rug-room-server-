import isEmail from 'isemail'

/**
 * Limits on the free text a player can put into their account and their rooms.
 *
 * Shared by `accounts` and `rooms` so one rule can't drift from the other — a username
 * and a room name are held to the same shape, and both are typed into the same client.
 *
 * These check only what a player SUPPLIES. Names the server generates go around them:
 * a dorm is called `@<username>'s Dorm` (see `rooms-db.ts`), which the name rule below
 * would reject, and auto-assigned usernames (`SwiftFox4821`, `Player42`) happen to
 * satisfy it. So validate at the request handler, never inside the db helpers.
 *
 * Emptiness is deliberately NOT checked here. Every caller already rejects an empty
 * value in its own words, and those sentences reach players through response envelopes
 * the client renders verbatim — see the client-contract notes in CLAUDE.md.
 */

/**
 * Name lengths. All three come from what the CLIENT will accept in the matching input
 * box, not from a round number: accepting more here would store a name the game can't
 * re-enter or edit, so the server matches the box rather than being generous.
 */
export const MAX_USERNAME_LENGTH = 50
export const MAX_DISPLAY_NAME_LENGTH = 15
export const MAX_ROOM_NAME_LENGTH = 32

/**
 * Club and event limits. Longer than the name limits above because these aren't
 * identifiers — a club name and an event name are titles, and both allow the
 * punctuation and spaces a title needs (clubs enforce their own charset rule; events
 * enforce none at all, since an event is called things like "Building a Better Room
 * Using Trigonometry").
 */
export const MAX_CLUB_NAME_LENGTH = 40
export const MAX_CLUB_DESCRIPTION_LENGTH = 512
export const MAX_EVENT_NAME_LENGTH = 64
export const MAX_EVENT_DESCRIPTION_LENGTH = 512

/**
 * Length in code points rather than UTF-16 units, so an emoji or other astral character
 * counts once instead of twice — the way a player counts what they typed.
 */
export const glyphLength = (value: string): number => Array.from(value).length

/** Max length of a profile bio. */
export const MAX_BIO_LENGTH = 255

/**
 * Letters and digits only — no spaces, punctuation, or accents.
 *
 * Deliberately narrow: these names are shown to other players, used to search, and (for
 * usernames) typed into a sign-in box, so anything that can be confused for another name
 * is worth refusing. It also rules out the homoglyph and right-to-left tricks that come
 * with allowing arbitrary Unicode.
 */
const NAME_PATTERN = /^[A-Za-z0-9]+$/

/**
 * Why a player-supplied name is unacceptable, or `null` when it's fine.
 *
 * `label` names the thing in the returned sentence ('username', 'room name'), so the
 * message reads correctly wherever it's surfaced. `max` is required rather than
 * defaulted: the three limits differ, and a caller that forgets which one it wants
 * should have to say so instead of silently taking someone else's.
 */
export function nameRejection(value: string, label: string, max: number): string | null {
	if (value.length > max) {
		return `Your ${label} can be at most ${max} characters.`
	}
	if (!NAME_PATTERN.test(value)) {
		return `Your ${label} can only contain letters and numbers.`
	}
	return null
}

/**
 * Whether a supplied email is one worth storing — RFC 5321/5322 syntax, via `isemail`.
 *
 * A hand-rolled pattern is the wrong shape of work here: this is a contact address
 * nothing is ever sent to in order to prove it, so the only thing a stricter regex buys
 * is more edge cases to get wrong. Note it also enforces the RFC's 254-character maximum
 * itself, which is why there's no separate length cap.
 *
 * It accepts a dotless domain (`someone@localhost`), which a dotted-domain rule would
 * refuse. That's the RFC being right and the shortcut being wrong, and an undeliverable
 * address costs nothing here.
 */
export function isValidEmail(value: string): boolean {
	return isEmail.validate(value)
}

/** Whether a supplied bio is within the stored length. */
export function isValidBio(value: string): boolean {
	return value.length <= MAX_BIO_LENGTH
}
