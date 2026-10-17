/**
 * Meta AI msmsg decrypt + text extraction
 * Ported 1:1 from baron-baileys-v2 (Utils/meta-ai-msmsg.js)
 */
import { hkdf, aesDecryptGCM } from './crypto.js'
import { proto } from '../../WAProto/index.js'
import { unpadRandomMax16 } from './generics.js'

const BOT_MESSAGE_INFO = 'Bot Message'
const KEY_LENGTH = 32

const toBuffer = (value: any): Buffer => {
	if (Buffer.isBuffer(value)) return value
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
	return Buffer.from(value)
}

/** Strips device suffix from LID JIDs: "user:device@lid" → "user@lid" */
const normalizeLidJid = (jid?: string | null) => {
	if (!jid || !jid.endsWith('@lid') || !jid.includes(':')) return jid || undefined
	return `${jid.split(':')[0]}@lid`
}

const selectMsgIdCandidates = (messageKey: {
	botEditTargetId?: string | null
	stanzaId?: string | null
	metaTargetId?: string | null
}) => {
	const seen = new Set<string>()
	const result: string[] = []
	for (const id of [messageKey?.botEditTargetId, messageKey?.stanzaId, messageKey?.metaTargetId]) {
		const s = id ? String(id) : ''
		if (s && !seen.has(s)) {
			seen.add(s)
			result.push(s)
		}
	}
	return result
}

const selectTargetJidCandidates = (messageKey: { meId?: string | null; meLid?: string | null }) => {
	const seen = new Set<string>()
	const result: string[] = []
	for (const jid of [normalizeLidJid(messageKey?.meId), normalizeLidJid(messageKey?.meLid)]) {
		const s = jid ? String(jid) : ''
		if (s && !seen.has(s)) {
			seen.add(s)
			result.push(s)
		}
	}
	return result
}

/**
 * Decrypts <enc type="msmsg"> bot messages.
 *
 * Two-pass HKDF — algorithm from bot_message.rs (BotMessageContext):
 *   k1    = HKDF(messageSecret, salt=∅, info="Bot Message",                     32)
 *   k2    = HKDF(k1,            salt=∅, info=msgID||target_sender_jid||bot_jid, 32)
 *   AAD   = msgID || 0x00 || bot_user_jid
 *   plain = AES-256-GCM.Decrypt(k2, encIv, encPayload, AAD)
 */
export const decryptMsmsgBotMessage = async (
	messageSecret: Uint8Array | Buffer,
	messageKey: {
		participant: string
		meId: string
		meLid?: string
		botEditTargetId?: string | null
		metaTargetId?: string | null
		stanzaId?: string | null
	},
	msMsg: { encIv?: Uint8Array | null; encPayload?: Uint8Array | null }
): Promise<Buffer> => {
	if (!messageSecret || (messageSecret instanceof Uint8Array && !messageSecret.byteLength)) {
		throw new Error('Missing required messageSecret for msmsg decryption')
	}
	if (!messageKey?.participant) throw new Error('Missing required participant for msmsg decryption')
	if (!messageKey?.meId) throw new Error('Missing required meId for msmsg decryption')
	if (!msMsg?.encIv) throw new Error('Missing required encIv for msmsg decryption')
	if (!msMsg?.encPayload) throw new Error('Missing required encPayload for msmsg decryption')

	const msgIdCandidates = selectMsgIdCandidates(messageKey)
	if (!msgIdCandidates.length) throw new Error('Missing required target message id for msmsg decryption')

	const targetJidCandidates = selectTargetJidCandidates(messageKey)
	if (!targetJidCandidates.length) throw new Error('Missing required target JID for msmsg decryption')

	const botJidBuf = Buffer.from(String(messageKey.participant))
	const payload = toBuffer(msMsg.encPayload)
	const iv = toBuffer(msMsg.encIv)

	const baseKey = Buffer.from(hkdf(toBuffer(messageSecret), KEY_LENGTH, { info: BOT_MESSAGE_INFO }))

	let lastError: any
	for (const msgId of msgIdCandidates) {
		const idBuf = Buffer.from(msgId)
		for (const targetJid of targetJidCandidates) {
			const infoBytes = Buffer.concat([idBuf, Buffer.from(targetJid), botJidBuf])
			const key = Buffer.from(hkdf(baseKey, KEY_LENGTH, { info: infoBytes.toString('latin1') }))
			const aad = Buffer.concat([idBuf, Buffer.from([0x00]), botJidBuf])
			try {
				return Buffer.from(aesDecryptGCM(payload, key, iv, aad))
			} catch (e) {
				lastError = e
			}
		}
	}

	const err = new Error('msmsg decryption failed: all key derivation candidates exhausted') as Error & { cause?: any }
	err.cause = lastError
	throw err
}

export const decodeDecryptedMsmsgMessage = (decrypted: Uint8Array | Buffer): proto.IMessage => {
	const buf = toBuffer(decrypted)
	try {
		const unpadded = Buffer.from(unpadRandomMax16(buf))
		const decoded = proto.Message.decode(unpadded)
		const hasContent = Object.keys(decoded).some(k => k !== 'messageContextInfo' && (decoded as any)[k] != null)
		if (hasContent) return decodeUnifiedResponseInPlace(decoded)
	} catch {
		/* fall through */
	}
	return decodeUnifiedResponseInPlace(proto.Message.decode(buf))
}

export const parseUnifiedResponseData = (data: any): any | null => {
	if (!data) return null
	try {
		let buf: Buffer
		if (Buffer.isBuffer(data)) buf = data
		else if (data instanceof Uint8Array) buf = Buffer.from(data)
		else if (typeof data === 'string') buf = Buffer.from(data, 'base64')
		else if (data.type === 'Buffer' && Array.isArray(data.data)) buf = Buffer.from(data.data)
		else return null
		return JSON.parse(buf.toString('utf8'))
	} catch {
		return null
	}
}

export const textFromUnifiedResponse = (data: any): string | null => {
	const j = parseUnifiedResponseData(data)
	if (!j) return null
	const parts: string[] = []
	for (const section of j.sections || []) {
		const t = section?.view_model?.primitive?.text
		if (t) parts.push(t)
	}
	return parts.length ? parts.join('\n') : null
}

export const textFromRichResponse = (rr: any): string | null => {
	if (!rr) return null
	if (Array.isArray(rr.submessages)) {
		const parts = rr.submessages
			.map((sm: any) => sm?.messageText)
			.filter((t: any) => typeof t === 'string' && t.length)
		if (parts.length) return parts.join('\n')
	}
	return textFromUnifiedResponse(rr.unifiedResponse?.data)
}

/**
 * Extract answer text from any Meta AI message body —
 * plain, protocolMessage/MESSAGE_EDIT streaming chunk, or richResponseMessage.
 */
export const extractMetaAiText = (message: proto.IMessage | null | undefined): string | null => {
	if (!message) return null
	const body = (message as any).protocolMessage?.editedMessage || message
	return (
		body.extendedTextMessage?.text ??
		body.conversation ??
		textFromRichResponse(body.richResponseMessage) ??
		null
	)
}

/**
 * Decode unifiedResponse.data IN PLACE: keep raw `data`, attach `decodedData` + `text`.
 */
export const decodeUnifiedResponseInPlace = <T extends proto.IMessage | any>(message: T): T => {
	if (!message || typeof message !== 'object') return message
	const bodies = [message, (message as any).protocolMessage?.editedMessage, (message as any).editedMessage].filter(
		Boolean
	)
	for (const body of bodies) {
		const ur = body.richResponseMessage?.unifiedResponse
		if (ur && ur.data != null && ur.decodedData === undefined) {
			ur.decodedData = parseUnifiedResponseData(ur.data)
			const txt = textFromUnifiedResponse(ur.data)
			if (txt != null) ur.text = txt
		}
	}
	return message
}