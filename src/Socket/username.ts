import type { SocketConfig } from '../Types'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { executeWMexQuery } from './mex.js'
import { makeNewsletterSocket } from './newsletter.js'

/**
 * w:mex query IDs for username operations.
 * Ported 1:1 from pou-code / Baileys-main (lib/Socket/username.js)
 *
 * Source: Java decompilation of WhatsApp 2.26.17.2 (C1568872p.java)
 * Data path: xwa2_username_check (C164057Wg.java:81)
 */
export const USERNAME_QUERY_IDS = {
	// Live-captured from WA 2.26.26.4 (phoenix-baileys / wa-logger)
	// Older pou-code IDs (...99520 / ...06056) often return GraphQL Bad Request
	CHECK: '26124072630599518', // UsernameCheck
	CHECK_MULTI: '27134626522840290', // UsernameCheckMulti (legacy; may vary)
	SET: '27108705368767936', // UsernameReserve / set
	GET: '32618050064506055', // GetMyUsername
	GET_RECOMMENDATIONS: '26077456248616956', // UsernameGetRecommendationsQuery
	PIN_SET: '25529696019976770', // UsernamePinSet
	LOOKUP: '25975613018777537', // interactive search by JID
	PROFILE: '25741205615468935' // profile by JID
} as const

export const USERNAME_CHECK_RESULT = {
	SUCCESS: 'SUCCESS',
	INVALID: 'INVALID'
} as const

export const USERNAME_SOURCE = {
	FB: 'FB',
	IG: 'IG',
	USER_INPUT: 'USER_INPUT',
	SUGGESTION: 'SUGGESTION'
} as const

export type UsernameCheckResult = {
	available: boolean
	username: string
	suggestions?: string[]
	rejectionReasons?: string[]
	suggestionsEligible?: boolean
	raw?: unknown
}

export const makeUsernameSocket = (config: SocketConfig) => {
	const sock = makeNewsletterSocket(config)
	const { query, generateMessageTag, executeUSyncQuery } = sock

	const mexQuery = <T = any>(variables: Record<string, unknown>, queryId: string, dataPath: string) =>
		executeWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)

	/**
	 * Check whether a username is available.
	 * Pou-code equivalent: checkUsername
	 */
	const checkUsername = async (username: string, includeSuggestions = true): Promise<UsernameCheckResult> => {
		if (!USERNAME_QUERY_IDS.CHECK) {
			throw new Error('Username CHECK query_id not configured')
		}

		// Try current ID, then legacy pou-code ID (WhatsApp rotates these)
		const checkIds = [USERNAME_QUERY_IDS.CHECK, '26124072630599520']
		let data: any
		let lastErr: any
		for (const qid of checkIds) {
			try {
				data = await mexQuery(
					{ username, include_suggestions: includeSuggestions },
					qid,
					'xwa2_username_check'
				)
				lastErr = null
				break
			} catch (e) {
				lastErr = e
			}
		}
		if (lastErr) throw lastErr

		// Support both snake_case (WA) and possible camelCase
		const result = data?.result ?? data?.Result
		const suggestions = data?.suggestions ?? data?.Suggestions ?? []
		const rejectionReasons = data?.rejection_reasons ?? data?.rejectionReasons ?? []
		const suggestionsEligible = data?.suggestions_eligible ?? data?.suggestionsEligible ?? true

		if (result === USERNAME_CHECK_RESULT.SUCCESS || result === 'SUCCESS') {
			return { available: true, username, raw: data }
		}

		return {
			available: false,
			username,
			suggestions: Array.isArray(suggestions) ? suggestions : [],
			rejectionReasons: Array.isArray(rejectionReasons) ? rejectionReasons : [],
			suggestionsEligible: Boolean(suggestionsEligible),
			raw: data
		}
	}

	/**
	 * Set your own username.
	 * Pou-code: setUsername
	 */
	const setUsername = async (
		username: string,
		options: { source?: string; sessionId?: string; pin?: string } = {}
	) => {
		if (!USERNAME_QUERY_IDS.SET) {
			throw new Error('Username SET query_id not configured')
		}
		const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options
		const variables: Record<string, unknown> = {
			username,
			reserved: false,
			source,
			...(sessionId ? { session_id: sessionId } : {}),
			...(pin ? { pin } : {})
		}
		return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set')
	}

	/**
	 * Delete (unset) your own username.
	 * Pou-code: deleteUsername — sends username=null on SET query
	 */
	const deleteUsername = async () => {
		if (!USERNAME_QUERY_IDS.SET) {
			throw new Error('Username SET query_id not configured')
		}
		return mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete')
	}

	/**
	 * Get your own current username.
	 * Pou-code: getMyUsername
	 */
	const getMyUsername = async (): Promise<string | null> => {
		if (!USERNAME_QUERY_IDS.GET) {
			throw new Error('Username GET query_id not configured')
		}
		const getIds = [USERNAME_QUERY_IDS.GET, '32618050064506056']
		let data: any
		let lastErr: any
		for (const qid of getIds) {
			try {
				data = await mexQuery({}, qid, 'xwa2_username_get')
				lastErr = null
				break
			} catch (e) {
				lastErr = e
			}
		}
		if (lastErr) throw lastErr
		return data?.username ?? data?.Username ?? null
	}

	/**
	 * Set or delete PIN for username.
	 * Pou-code: setUsernamePin
	 */
	const setUsernamePin = async (pin: string | null) => {
		if (!USERNAME_QUERY_IDS.PIN_SET) {
			throw new Error('Username PIN_SET query_id not configured')
		}
		return mexQuery({ pin }, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set')
	}

	/**
	 * Look up contact by @username via USync.
	 * Pou-code: findUserByUsername
	 */
	const findUserByUsername = async (username: string, pin?: string) => {
		const usyncQuery = new USyncQuery().withContactProtocol()
		const user = new USyncUser().withUsername(username)
		if (pin) user.withUsernameKey(pin)
		usyncQuery.withUser(user)
		const result = await executeUSyncQuery(usyncQuery)
		if (!result?.list?.length) return null
		const entry = result.list[0] as any
		if (!entry) return null
		return {
			jid: entry.id,
			contact: entry.contact ?? false
		}
	}

	/**
	 * Fetch usernames for contacts by JID.
	 * Pou-code: fetchContactUsernames
	 */
	const fetchContactUsernames = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withUsernameProtocol()
		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}
		const result = await executeUSyncQuery(usyncQuery)
		return result?.list ?? []
	}

	/**
	 * Check multiple usernames at once.
	 * Pou-code: checkUsernameMulti
	 */
	const checkUsernameMulti = async (usernames: string[]) => {
		return mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi')
	}

	/**
	 * Username recommendations.
	 * Pou-code: getUsernameRecommendations
	 */
	const getUsernameRecommendations = async (source: string | null = null) => {
		const variables: Record<string, unknown> = {}
		if (source) variables.source = source
		return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations')
	}

	return {
		...sock,
		checkUsername,
		checkUsernameMulti,
		setUsername,
		deleteUsername,
		getMyUsername,
		getUsernameRecommendations,
		setUsernamePin,
		findUserByUsername,
		fetchContactUsernames,
		USERNAME_QUERY_IDS,
		USERNAME_CHECK_RESULT,
		USERNAME_SOURCE
	}
}

export type UsernameSocket = ReturnType<typeof makeUsernameSocket>
