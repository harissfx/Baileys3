/**
 * Meta AI reply helpers: wait for a (streamed) reply from the Meta AI bot,
 * collect image URLs / media from richResponseMessage + unifiedResponse,
 * and download generated images.
 *
 * Usage:
 *   const waiting = waitForMetaAiReply(sock, { timeoutMs: 90_000 })
 *   await sock.sendMetaAI('hello')
 *   const reply = await waiting   // { text, images, unified, raw }
 */
import type { proto } from '../../WAProto/index.js'
import type { BaileysEventEmitter, WAMessage } from '../Types'
import { extractMetaAiText } from './meta-ai-msmsg'

export const META_AI_BOT_JID = '867051314767696@bot'
export const META_AI_REPLY_TIMEOUT_MS = 90_000

const IMAGE_URL_REGEX = /^https?:\/\/\S+/i
const IMAGE_HINT_REGEX = /(\.(png|jpe?g|webp|gif)(\?|$)|fbcdn|scontent|cdn\.)/i

export type MetaAiReply = {
	/** Reply text (may still contain internal `container:///` image refs, see cleanMetaAiText) */
	text: string
	/** Image URLs found in the rich response */
	images: string[]
	/** Decoded unifiedResponse payload, if any */
	unified: any | null
	/** Last raw message that updated this reply */
	raw: WAMessage
}

export type WaitForMetaAiReplyOptions = {
	/** Reject if nothing arrives within this time. Default 90s */
	timeoutMs?: number
	/** Resolve once no new update arrived for this long. Default 3s */
	settleMs?: number
}

export type MetaAiMediaItem = {
	url: string
	mime_type: string
	[key: string]: any
}

export type MetaAiImage = {
	buffer: Buffer
	mimetype: 'image/jpeg' | 'image/png' | 'image/webp'
}

/** Collect image URLs from a richResponseMessage (grid/inline images + scan of unifiedResponse). */
export const getMetaAiImageUrls = (message: proto.IMessage | null | undefined): string[] => {
	const urls = new Set<string>()
	const body: any = (message as any)?.protocolMessage?.editedMessage || message
	const rich = body?.richResponseMessage
	if (!rich) return []

	const addUrlObject = (obj: any) => {
		if (!obj) return
		const url = obj.imageHighResUrl || obj.imagePreviewUrl || obj.sourceUrl
		if (url) urls.add(url)
	}

	for (const sub of rich.submessages || []) {
		for (const obj of sub?.gridImageMetadata?.imageUrls || []) addUrlObject(obj)
		addUrlObject(sub?.gridImageMetadata?.gridImageUrl)
		addUrlObject(sub?.imageMetadata?.imageUrl)
	}

	const walk = (value: any, depth = 0) => {
		if (depth > 12 || value == null) return
		if (typeof value === 'string') {
			if (IMAGE_URL_REGEX.test(value) && IMAGE_HINT_REGEX.test(value)) urls.add(value)
		} else if (Array.isArray(value)) {
			value.forEach(item => walk(item, depth + 1))
		} else if (typeof value === 'object') {
			Object.values(value).forEach(item => walk(item, depth + 1))
		}
	}

	walk(rich.unifiedResponse?.decodedData)
	return [...urls]
}

/** Find image media objects (`{ url, mime_type: image/* }`) inside a unifiedResponse payload. */
export const getMetaAiMediaItems = (root: any): MetaAiMediaItem[] => {
	const items: MetaAiMediaItem[] = []

	const parse = (value: any) => {
		if (typeof value !== 'string') return value
		const trimmed = value.trim()
		if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
			try {
				return JSON.parse(trimmed)
			} catch {
				return value
			}
		}

		return value
	}

	const walk = (input: any, depth: number) => {
		const value = parse(input)
		if (depth > 14 || value == null || typeof value !== 'object') return
		if (Array.isArray(value)) {
			value.forEach(item => walk(item, depth + 1))
			return
		}

		if (typeof value.url === 'string' && typeof value.mime_type === 'string' && value.mime_type.startsWith('image/')) {
			items.push(value)
		}

		Object.values(value).forEach(item => walk(item, depth + 1))
	}

	walk(root, 0)
	return items
}

/**
 * Download a Meta AI image straight from `media.url`.
 * WebP is converted to JPEG when `sharp` is installed, otherwise returned as-is.
 */
export const fetchMetaAiImage = async (item: Pick<MetaAiMediaItem, 'url'>): Promise<MetaAiImage> => {
	const res = await fetch(item.url, { headers: { 'User-Agent': 'WhatsApp/2.24.20.85 A' } })
	if (!res.ok) throw new Error(`HTTP ${res.status}`)

	const buffer = Buffer.from(await res.arrayBuffer())
	const head = buffer.subarray(0, 12)
	const isWebp = head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP'
	const isPng = head[0] === 0x89 && head[1] === 0x50
	const isJpeg = head[0] === 0xff && head[1] === 0xd8
	if (!isWebp && !isPng && !isJpeg) throw new Error('not a valid image')

	if (isWebp) {
		try {
			const sharp = await import('sharp')
			const jpeg = await sharp.default(buffer).jpeg({ quality: 92 }).toBuffer()
			return { buffer: jpeg, mimetype: 'image/jpeg' }
		} catch {
			return { buffer, mimetype: 'image/webp' }
		}
	}

	return { buffer, mimetype: isPng ? 'image/png' : 'image/jpeg' }
}

/** Strip internal Meta AI image refs (`![..](container:///..)`) that are not openable URLs. */
export const cleanMetaAiText = (text?: string | null): string =>
	String(text || '')
		.replace(/!\[[^\]]*\]\(container:[^)]*\)/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()

/**
 * Wait for the Meta AI reply (msmsg / MESSAGE_EDIT streaming).
 * The answer arrives in chunks, so the result is resolved once no new update
 * arrived for `settleMs`. Call this BEFORE `sock.sendMetaAI(...)`.
 */
export const waitForMetaAiReply = (
	sock: { ev: BaileysEventEmitter },
	{ timeoutMs = META_AI_REPLY_TIMEOUT_MS, settleMs = 3000 }: WaitForMetaAiReplyOptions = {}
): Promise<MetaAiReply> => {
	return new Promise((resolve, reject) => {
		let best: MetaAiReply | null = null
		let settleTimer: NodeJS.Timeout | undefined

		const cleanup = () => {
			clearTimeout(timer)
			clearTimeout(settleTimer)
			sock.ev.off('messages.upsert', onUpsert)
		}

		const finish = () => {
			cleanup()
			resolve(best!)
		}

		const timer = setTimeout(() => {
			if (best) return finish()
			cleanup()
			reject(new Error(`Timeout ${timeoutMs / 1000}s — Meta AI has not replied`))
		}, timeoutMs)

		const onUpsert = ({ messages }: { messages: WAMessage[] }) => {
			for (const msg of messages || []) {
				const remoteJid = msg.key?.remoteJid || ''
				const participant = msg.key?.participant || ''
				const fromBot =
					remoteJid.endsWith('@bot') ||
					participant.endsWith('@bot') ||
					remoteJid === META_AI_BOT_JID ||
					participant === META_AI_BOT_JID
				if (!fromBot) continue

				const text = extractMetaAiText(msg.message)
				const images = getMetaAiImageUrls(msg.message)
				const body: any = (msg.message as any)?.protocolMessage?.editedMessage || msg.message
				const unified = body?.richResponseMessage?.unifiedResponse?.decodedData || null
				const hasText = !!text && !!String(text).trim()

				if (hasText || images.length || unified) {
					best = {
						text: hasText ? String(text).trim() : best?.text || '',
						images: images.length ? images : best?.images || [],
						unified: unified || best?.unified || null,
						raw: msg
					}
					clearTimeout(settleTimer)
					settleTimer = setTimeout(finish, settleMs)
				}
			}
		}

		sock.ev.on('messages.upsert', onUpsert)
	})
}