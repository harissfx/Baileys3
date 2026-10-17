import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { WAMessage, WAMessageKey } from '../Types/index.js'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal.js'
import {
	areJidsSameUser,
	type BinaryNode,
	isHostedLidUser,
	isHostedPnUser,
	isJidBroadcast,
	isJidGroup,
	isJidMetaAI,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser
} from '../WABinary/index.js'
import { unpadRandomMax16 } from './generics.js'
import type { ILogger } from './logger.js'
import {
	decryptMsmsgBotMessage,
	decodeDecryptedMsmsgMessage,
	decodeUnifiedResponseInPlace
} from './meta-ai-msmsg.js'

const MAX_SECRETS_PER_CHAT = 8
const botMessageSecrets = new Map<string, Buffer>()
const botRecentSecretsByChat = new Map<string, { id: string; secret: Buffer }[]>()

const pushRecentChatSecret = (chatJid: string, id: string, secretBuf: Buffer) => {
	if (!chatJid || !secretBuf) return
	const existing = botRecentSecretsByChat.get(chatJid) || []
	const filtered = existing.filter(item => item.id !== id && !item.secret.equals(secretBuf))
	filtered.unshift({ id, secret: secretBuf })
	if (filtered.length > MAX_SECRETS_PER_CHAT) filtered.length = MAX_SECRETS_PER_CHAT
	botRecentSecretsByChat.set(chatJid, filtered)
}

/** Store messageSecret for Meta AI msmsg decryption (by outgoing message id). */
export const setBotMessageSecret = (id: string | undefined | null, secret: any, chatJid?: string | null) => {
	if (!id || !secret) return
	let buf: Buffer
	if (Buffer.isBuffer(secret)) buf = secret
	else if (secret instanceof Uint8Array) buf = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
	else if (typeof secret === 'string') buf = Buffer.from(secret, 'base64')
	else return
	botMessageSecrets.set(id, buf)
	if (chatJid) pushRecentChatSecret(chatJid, id, buf)
}

export const getBotMessageSecret = (id?: string | null) => (id ? botMessageSecrets.get(id) || null : null)

export const getDecryptionJid = async (sender: string, repository: SignalRepositoryWithLIDStore): Promise<string> => {
	if (isLidUser(sender) || isHostedLidUser(sender)) {
		return sender
	}

	const mapped = await repository.lidMapping.getLIDForPN(sender)
	return mapped || sender
}

const storeMappingFromEnvelope = async (
	stanza: BinaryNode,
	sender: string,
	repository: SignalRepositoryWithLIDStore,
	decryptionJid: string,
	logger: ILogger
): Promise<void> => {
	// TODO: Handle hosted IDs
	const { senderAlt } = extractAddressingContext(stanza)

	if (senderAlt && isLidUser(senderAlt) && isPnUser(sender) && decryptionJid === sender) {
		try {
			await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
			await repository.migrateSession(sender, senderAlt)
			logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope')
		} catch (error) {
			logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping')
		}
	}
}

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted'

// Retry configuration for failed decryption
export const DECRYPTION_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 100,
	sessionRecordErrors: ['No session record', 'SessionError: No session record']
}

/** NACK reason codes we send to the server (client → server) */
export const NACK_REASONS = {
	SenderReachoutTimelocked: 463,
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

/**
 * Server-side error codes returned in ack stanzas (server → client) that we
 * currently have dedicated handlers for. Extend as more handlers are added.
 * Distinct from the client-side NackReason enum (WAWebCreateNackFromStanza).
 */
export const SERVER_ERROR_CODES = {
	/**
	 * 1:1 message missing privacy token (tctoken). Usually means the account is
	 * restricted: WhatsApp blocks starting new chats but preserves existing ones,
	 * since established chats already carry a tctoken.
	 */
	MessageAccountRestriction: '463',
	/** Stanza validation failure (SMAX_INVALID) — likely stale device session */
	SmaxInvalid: '479'
} as const

type MessageType =
	| 'chat'
	| 'peer_broadcast'
	| 'other_broadcast'
	| 'group'
	| 'direct_peer_status'
	| 'other_status'
	| 'newsletter'

export const extractAddressingContext = (stanza: BinaryNode) => {
	let senderAlt: string | undefined
	let recipientAlt: string | undefined

	const sender = stanza.attrs.participant || stanza.attrs.from
	const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')

	if (addressingMode === 'lid') {
		// Message is LID-addressed: sender is LID, extract corresponding PN
		// without device data
		senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
		recipientAlt = stanza.attrs.recipient_pn
		// with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	} else {
		// Message is PN-addressed: sender is PN, extract corresponding LID
		// without device data
		senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
		recipientAlt = stanza.attrs.recipient_lid

		//with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	}

	return {
		addressingMode,
		senderAlt,
		recipientAlt
	}
}

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
	let msgType: MessageType
	let chatId: string
	let author: string
	let fromMe = false

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const recipient: string | undefined = stanza.attrs.recipient

	if (!msgId) {
		throw new Boom('Invalid message stanza: missing id attribute', { data: stanza })
	}

	if (!from) {
		throw new Boom('Invalid message stanza: missing from attribute', { data: stanza })
	}

	const addressingContext = extractAddressingContext(stanza)

	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

	// Meta AI (@bot) diperlakukan sebagai chat 1:1, kalau tidak balasannya ditolak 'Unknown message type'
	if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from) || isJidMetaAI(from)) {
		if (recipient && !isJidMetaAI(recipient)) {
			if (!isMe(from) && !isMeLid(from)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			if (isMe(from) || isMeLid(from)) {
				fromMe = true
			}

			chatId = recipient
		} else {
			// Peer-routed self stanzas (history sync, app-state sync, etc.) arrive
			// with `from` set to our own device but no `recipient` attribute —
			// still mark as fromMe so self-only protocolMessage handlers run.
			if (isMe(from) || isMeLid(from)) {
				fromMe = true
			}

			chatId = from
		}

		msgType = 'chat'
		author = from
	} else if (isJidGroup(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		if (isMe(participant) || isMeLid(participant)) {
			fromMe = true
		}

		msgType = 'group'
		author = participant
		chatId = from
	} else if (isJidBroadcast(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		if (isJidStatusBroadcast(from)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}

		fromMe = isParticipantMe
		chatId = from
		author = participant
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from

		if (isMe(from) || isMeLid(from)) {
			fromMe = true
		}
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const pushname = stanza?.attrs?.notify

	const key: WAMessageKey = {
		remoteJid: chatId,
		remoteJidAlt: !isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		remoteJidUsername: !isJidGroup(chatId)
			? stanza.attrs.peer_recipient_username || stanza.attrs.recipient_username
			: undefined,
		fromMe,
		id: msgId,
		participant,
		participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
		participantUsername: stanza.attrs.participant ? stanza.attrs.participant_username : undefined,
		addressingMode: addressingContext.addressingMode,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}

	const fullMessage: WAMessage = {
		key,
		category: stanza.attrs.category,
		messageTimestamp: +stanza.attrs.t!,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if (key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepositoryWithLIDStore,
	logger: ILogger
) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	let metaTargetId: string | null = null
	let botEditTargetId: string | null = null
	let botType: string | null = null
	let metaTargetSenderJid: string | null = null
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				let hasMsmsg = false
				for (const n of stanza.content) {
					if ((n as any)?.attrs?.type === 'msmsg') {
						hasMsmsg = true
						break
					}
				}
				if (hasMsmsg) {
					for (const { tag, attrs } of stanza.content as any[]) {
						if (tag === 'meta' && attrs?.target_id) metaTargetId = attrs.target_id
						if (tag === 'meta' && attrs?.target_sender_jid) metaTargetSenderJid = attrs.target_sender_jid
						if (tag === 'bot' && attrs && 'edit_target_id' in attrs) botEditTargetId = attrs.edit_target_id
						if (tag === 'bot' && attrs?.edit) botType = attrs.edit
					}
				}
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}

					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true // TODO: remove from here and add a STUB TYPE
					}

					if (attrs.count && tag === 'enc') {
						fullMessage.retryCount = Number(attrs.count)
					}

					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if (!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer: Uint8Array

					const decryptionJid = await getDecryptionJid(author, repository)

					if (tag !== 'plaintext') {
						// TODO: Handle hosted devices
						await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger)
					}

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type

						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break
							case 'pkmsg':
							case 'msg':
								msgBuffer = await repository.decryptMessage({
									jid: decryptionJid,
									type: e2eType,
									ciphertext: content
								})
								break
							case 'msmsg': {
								// null = no bot node; 'full'/'last' = complete; 'first' = streaming partial (skip)
								if (botType !== null && !['full', 'last'].includes(botType)) {
									msgBuffer = new Uint8Array(0)
									break
								}
								const secretIdCandidates = [botEditTargetId, metaTargetId, fullMessage.key?.id].filter(
									Boolean
								) as string[]
								const secretCandidates: { source: string; secret: Buffer }[] = []
								const seenSecrets = new Set<string>()
								for (const idCandidate of secretIdCandidates) {
									const byId = botMessageSecrets.get(idCandidate)
									if (!byId) continue
									const fp = byId.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `id:${idCandidate}`, secret: byId })
									}
								}
								const chatRecent = botRecentSecretsByChat.get(sender) || []
								for (const item of chatRecent) {
									const fp = item.secret.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `chat:${item.id}`, secret: item.secret })
									}
									if (secretCandidates.length >= 6) break
								}
								if (!secretCandidates.length) {
									logger.warn(
										{ metaTargetId, botType, secretIdCandidates },
										'msmsg: no candidate messageSecret found, skipping'
									)
									msgBuffer = new Uint8Array(0)
									break
								}
								const msMsg = proto.MessageSecretMessage.decode(content)
								const helperKey = {
									participant: author,
									meId: metaTargetSenderJid || `${meLid.split(':')[0]}@lid`,
									meLid,
									botEditTargetId,
									metaTargetId,
									stanzaId: stanza.attrs?.id
								}
								let decryptErr: any
								let decrypted: Buffer | undefined
								for (const candidate of secretCandidates) {
									try {
										decrypted = await decryptMsmsgBotMessage(candidate.secret, helperKey, msMsg)
										logger.debug({ source: candidate.source }, 'msmsg: decrypted with candidate secret')
										break
									} catch (e) {
										decryptErr = e
									}
								}
								if (!decrypted) {
									logger.warn(
										{
											secretCandidateSources: secretCandidates.map(c => c.source),
											cause: decryptErr?.message
										},
										'msmsg: helper decryption failed for all candidate secrets'
									)
									throw decryptErr || new Error('msmsg decryption failed')
								}
								msgBuffer = decrypted
								break
							}
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						if (!msgBuffer || (msgBuffer instanceof Uint8Array && msgBuffer.byteLength === 0)) {
							continue
						}

						let msg: proto.IMessage =
							e2eType === 'msmsg'
								? decodeDecryptedMsmsgMessage(msgBuffer)
								: proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer)

						const outerMessageContextInfo = msg.messageContextInfo
						msg = msg.deviceSentMessage?.message || msg
						if (outerMessageContextInfo && !msg.messageContextInfo) {
							msg.messageContextInfo = outerMessageContextInfo
						}

						decodeUnifiedResponseInPlace(msg)
						if (msg.protocolMessage?.editedMessage) {
							decodeUnifiedResponseInPlace(msg.protocolMessage.editedMessage)
						}

						const secret = msg.messageContextInfo?.messageSecret
						if (secret && fullMessage.key?.id) {
							const secretBuf = Buffer.isBuffer(secret)
								? secret
								: Buffer.from(
										(secret as Uint8Array).buffer,
										(secret as Uint8Array).byteOffset,
										(secret as Uint8Array).byteLength
									)
							setBotMessageSecret(fullMessage.key.id, secretBuf, fullMessage.key.remoteJid)
						}
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message')
							}
						}

						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch (err: any) {
						const errorContext = {
							key: fullMessage.key,
							err,
							messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
							sender,
							author,
							isSessionRecordError: isSessionRecordError(err)
						}

						logger.error(errorContext, 'failed to decrypt message')

						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message.toString()]
					}
				}
			}

			// if nothing was found to decrypt
			if (!decryptables && !fullMessage.key?.isViewOnce) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}

/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error: any): boolean {
	const errorMessage = error?.message || error?.toString() || ''
	return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern))
}