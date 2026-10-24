import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

/** Normalize WA binary content to UTF-8 string (pou-code style + safe variants) */
function contentToString(content: unknown): string {
	if (content == null) return ''
	if (typeof content === 'string') return content
	if (Buffer.isBuffer(content)) return content.toString('utf-8')
	if (content instanceof Uint8Array) return Buffer.from(content).toString('utf-8')
	if (Array.isArray(content)) {
		const parts: Buffer[] = []
		for (const c of content) {
			if (Buffer.isBuffer(c)) parts.push(c)
			else if (c instanceof Uint8Array) parts.push(Buffer.from(c))
			else if (typeof c === 'string') parts.push(Buffer.from(c, 'utf-8'))
			else if (c && typeof c === 'object' && 'content' in (c as any)) {
				const inner = contentToString((c as any).content)
				if (inner) parts.push(Buffer.from(inner, 'utf-8'))
			}
		}
		return Buffer.concat(parts).toString('utf-8')
	}
	return String(content)
}

/**
 * WA sometimes returns newsletter MEX payloads as binary/protobuf-ish blobs
 * instead of JSON. Extract the useful fields so callers don't fail hard.
 */
function recoverFromBinaryMex(raw: string, dataPath: string): any | null {
	const jidMatch = raw.match(/(\d{10,}@newsletter)/)
	if (!jidMatch) return null

	const jid = jidMatch[1]
	const inviteMatch = raw.match(/(0029[A-Za-z0-9]{15,24})/)
	let invite = inviteMatch ? inviteMatch[1] : undefined
	// trim accidental trailing digit from invite
	if (invite && /\d$/.test(invite) && invite.length > 22) {
		invite = invite.replace(/\d$/, '')
	}

	// Human-readable name candidates (skip technical tokens & pure digits)
	const skip = new Set([
		'ACTIVE',
		'PREVIEW',
		'UNVERIFIED',
		'VERIFIED',
		'ALL',
		'NEWSLETTER',
		'CHANNEL',
		'GUEST',
		'SUBSCRIBED',
		'ADMIN'
	])
	const candidates: string[] = []
	const re = /([A-Za-z][A-Za-z0-9][A-Za-z0-9 _\-.]{0,48}[A-Za-z0-9])/g
	let m: RegExpExecArray | null
	while ((m = re.exec(raw)) !== null) {
		const captured = m[1]
		if (!captured) continue
		let s = captured.trim()
		if (skip.has(s.toUpperCase())) continue
		if (/^\d+$/.test(s)) continue
		if (s.includes('@')) continue
		if (s.startsWith('0029')) continue
		if (s.length < 2) continue
		// binary decode often glues ids after the name
		const head = s.split(/\d{5,}/)[0] ?? ''
		s = head.replace(/0029[A-Za-z0-9]*$/g, '').trim()
		if (s.length < 2 || /^\d+$/.test(s)) continue
		candidates.push(s)
	}
	candidates.sort((a, b) => {
		const score = (x: string) => (/[A-Za-z]/.test(x) ? 2 : 0) + (/\s/.test(x) ? 3 : 0) + Math.min(x.length, 24) / 24
		return score(b) - score(a)
	})
	const name = candidates[0]

	const stateMatch = raw.match(/\b(ACTIVE|INACTIVE|GEOSUSPENDED)\b/)
	const verificationMatch = raw.match(/\b(VERIFIED|UNVERIFIED)\b/)
	const viewerMatch = raw.match(/\b(GUEST|SUBSCRIBER|ADMIN|OWNER)\b/i)

	// Shape expected by parseNewsletterMetadata / newsletter callers
	const recovered = {
		id: jid,
		state: stateMatch ? stateMatch[1] : undefined,
		thread_metadata: {
			id: jid,
			name: name ? { text: name } : undefined,
			invite: invite,
			verification: verificationMatch ? verificationMatch[1] : undefined,
			subscribers_count: undefined,
			description: undefined
		},
		viewer_metadata: viewerMatch?.[1] ? { role: viewerMatch[1].toUpperCase() } : undefined,
		// also flat fields some callers read
		name: name,
		invite: invite,
		_recoveredFromBinary: true
	}

	// Only use recovery for newsletter-related paths (or always if jid found)
	if (!dataPath || dataPath.includes('newsletter') || dataPath.includes('xwa2_')) {
		return recovered
	}
	return null
}

function tryParseJsonLoose(raw: string): any | null {
	const cleaned = raw.replace(/^\uFEFF/, '').trim()
	try {
		return JSON.parse(cleaned)
	} catch {
		/* continue */
	}
	// embedded JSON object
	const start = cleaned.indexOf('{')
	const end = cleaned.lastIndexOf('}')
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(cleaned.slice(start, end + 1))
		} catch {
			/* continue */
		}
	}
	// double-encoded string
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		try {
			const once = JSON.parse(cleaned)
			if (typeof once === 'string') return JSON.parse(once)
			return once
		} catch {
			/* continue */
		}
	}
	return null
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)

	if (result?.attrs?.type === 'error') {
		const errNode = getBinaryNodeChild(result, 'error')
		const code = errNode?.attrs?.code || result.attrs?.code || '400'
		const text = errNode?.attrs?.text || errNode?.attrs?.code || 'MEX IQ error'
		throw new Boom(`MEX IQ error: ${text}`, { statusCode: Number(code) || 400, data: result })
	}

	const child = getBinaryNodeChild(result, 'result')
	const raw = contentToString(child?.content)

	if (raw && raw.trim()) {
		let data: any = tryParseJsonLoose(raw)

		if (!data) {
			const recovered = recoverFromBinaryMex(raw, dataPath)
			if (recovered) {
				// return as if GraphQL data[dataPath] === recovered
				return recovered as T
			}
			throw new Boom('Failed to parse MEX JSON response', {
				statusCode: 500,
				data: {
					preview: raw.slice(0, 400),
					queryId,
					dataPath,
					resultAttrs: result?.attrs
				}
			})
		}

		const errors = data?.errors
		if (Array.isArray(errors) && errors.length > 0) {
			const firstError = errors[0] ?? {}
			const errorMessages = errors.map((err: any) => err?.message || 'Unknown error').join(', ')
			const errorCode = firstError?.extensions?.error_code || firstError?.extensions?.errorCode || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, {
				statusCode: Number(errorCode) || 400,
				data: firstError
			})
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
		if (dataPath && typeof data?.[dataPath] !== 'undefined') {
			return data[dataPath] as T
		}
		if (data?.data && dataPath && data.data[dataPath] === null) {
			return null as T
		}
		// some WA builds return the object at the root
		if (data && typeof data === 'object' && ('id' in data || 'thread_metadata' in data)) {
			return data as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: (dataPath || 'mex query').replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, {
		statusCode: 400,
		data: {
			queryId,
			dataPath,
			hasResultChild: Boolean(child),
			rawPreview: raw ? raw.slice(0, 200) : null,
			resultAttrs: result?.attrs
		}
	})
}
