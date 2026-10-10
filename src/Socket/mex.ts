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
				// nested binary node — skip structure, only leaf content
				const inner = contentToString((c as any).content)
				if (inner) parts.push(Buffer.from(inner, 'utf-8'))
			}
		}
		return Buffer.concat(parts).toString('utf-8')
	}
	return String(content)
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)

	// IQ-level error (type=error)
	if (result?.attrs?.type === 'error') {
		const errNode = getBinaryNodeChild(result, 'error')
		const code = errNode?.attrs?.code || result.attrs?.code || '400'
		const text = errNode?.attrs?.text || errNode?.attrs?.code || 'MEX IQ error'
		throw new Boom(`MEX IQ error: ${text}`, { statusCode: Number(code) || 400, data: result })
	}

	const child = getBinaryNodeChild(result, 'result')
	const raw = contentToString(child?.content)

	if (raw && raw.trim()) {
		let data: any
		try {
			// Some responses are double-encoded or have BOM
			const cleaned = raw.replace(/^\uFEFF/, '').trim()
			data = JSON.parse(cleaned)
		} catch {
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
			const errorCode =
				firstError?.extensions?.error_code ||
				firstError?.extensions?.errorCode ||
				400
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
		// null is a valid GraphQL payload (e.g. no username set)
		if (data?.data && dataPath && data.data[dataPath] === null) {
			return null as T
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
