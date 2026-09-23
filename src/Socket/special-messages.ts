/**
 * Special message type helpers ported from wbails (Baileys2 / @qwerty-xcv/baileys) luxu.js
 * Allows Baileys2-style payloads (productMessage, orderMessage, pollResultMessage, etc.)
 * to work on top of the official Baileys generation pipeline.
 */
import { randomBytes } from 'node:crypto'
import { proto } from '../../WAProto/index.js'
import type { WAMessage } from '../Types/index.js'
import {
	generateMessageID,
	generateWAMessage,
	generateWAMessageContent,
	generateWAMessageFromContent
} from '../Utils/index.js'
import { isJidGroup } from '../WABinary/index.js'

type UploadFn = any

type UtilsLike = {
	generateWAMessageContent: typeof generateWAMessageContent
	generateWAMessageFromContent: typeof generateWAMessageFromContent
	generateWAMessage: typeof generateWAMessage
	generateMessageID: () => string
}

export type SpecialMessageType =
	| 'PAYMENT'
	| 'PRODUCT'
	| 'ALBUM'
	| 'EVENT'
	| 'POLL_RESULT'
	| 'ORDER'
	| 'GROUP_STATUS'
	| 'GROUP_LABEL'

export class SpecialMessageHandler {
	constructor(
		private utils: UtilsLike,
		private waUploadToServer: UploadFn,
		private relayMessage: (jid: string, content: proto.IMessage, options: any) => Promise<string>,
		private userJid: string
	) {}

	detectType(content: any): SpecialMessageType | null {
		if (!content || typeof content !== 'object') return null
		if (content.requestPaymentMessage) return 'PAYMENT'
		if (content.productMessage) return 'PRODUCT'
		if (content.albumMessage && Array.isArray(content.albumMessage)) return 'ALBUM'
		if (content.eventMessage) return 'EVENT'
		if (content.pollResultMessage) return 'POLL_RESULT'
		if (content.orderMessage || (content.orderTitle && content.totalAmount1000 !== undefined)) return 'ORDER'
		if (content.groupStatus) return 'GROUP_STATUS'
		if (content.groupLabel) return 'GROUP_LABEL'
		return null
	}

	private opts(extra: Record<string, any> = {}) {
		return {
			userJid: this.userJid,
			upload: this.waUploadToServer,
			...extra
		}
	}

	async handlePayment(content: any, quoted?: any) {
		const data = content.requestPaymentMessage
		let notes: any = {}

		if (data.sticker?.stickerMessage) {
			notes = {
				stickerMessage: {
					...data.sticker.stickerMessage,
					contextInfo: {
						stanzaId: quoted?.key?.id,
						participant: quoted?.key?.participant || content.sender,
						quotedMessage: quoted?.message
					}
				}
			}
		} else if (data.note) {
			notes = {
				extendedTextMessage: {
					text: data.note,
					contextInfo: {
						stanzaId: quoted?.key?.id,
						participant: quoted?.key?.participant || content.sender,
						quotedMessage: quoted?.message
					}
				}
			}
		}

		return {
			requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
				expiryTimestamp: data.expiry || 0,
				amount1000: data.amount || 0,
				currencyCodeIso4217: data.currency || 'IDR',
				requestFrom: data.from || '0@s.whatsapp.net',
				noteMessage: notes,
				background: data.background ?? {
					id: 'DEFAULT',
					placeholderArgb: 0xfff0f0f0
				}
			})
		}
	}

	async handleProduct(content: any, _jid: string, _quoted?: any) {
		// Struktur disamakan dengan @poucode/baileys (luxu.js) yang sudah terbukti jalan
		const {
			title,
			description,
			thumbnail,
			productId,
			retailerId,
			url,
			body = '',
			footer = '',
			buttons = [],
			priceAmount1000 = null,
			currencyCode = 'IDR'
		} = content.productMessage

		let productImage: any

		if (Buffer.isBuffer(thumbnail)) {
			const { imageMessage } = await this.utils.generateWAMessageContent(
				{ image: thumbnail } as any,
				{ upload: this.waUploadToServer } as any
			)
			productImage = imageMessage
		} else if (thumbnail && typeof thumbnail === 'object' && (thumbnail as any).url) {
			const { imageMessage } = await this.utils.generateWAMessageContent(
				{ image: { url: (thumbnail as any).url } } as any,
				{ upload: this.waUploadToServer } as any
			)
			productImage = imageMessage
		} else if (thumbnail) {
			const { imageMessage } = await this.utils.generateWAMessageContent(
				{ image: thumbnail } as any,
				{ upload: this.waUploadToServer } as any
			)
			productImage = imageMessage
		} else {
			const { imageMessage } = await this.utils.generateWAMessageContent(
				{ image: { url: 'https://picsum.photos/400/400' } } as any,
				{ upload: this.waUploadToServer } as any
			)
			productImage = imageMessage
		}

		if (!productImage) {
			throw new Error('productImage upload gagal — product card butuh gambar valid')
		}

		return {
			viewOnceMessage: {
				message: {
					interactiveMessage: {
						body: { text: body },
						footer: { text: footer },
						header: {
							title,
							hasMediaAttachment: true,
							productMessage: {
								product: {
									productImage,
									productId,
									title,
									description,
									currencyCode,
									priceAmount1000,
									retailerId,
									url,
									productImageCount: 1
								},
								businessOwnerJid: '0@s.whatsapp.net'
							}
						},
						nativeFlowMessage: { buttons }
					}
				}
			}
		}
	}

	async handleAlbum(content: any, jid: string, quoted?: any) {
		const array = content.albumMessage as any[]
		const album = await this.utils.generateWAMessageFromContent(
			jid,
			{
				messageContextInfo: {
					messageSecret: randomBytes(32)
				},
				albumMessage: {
					expectedImageCount: array.filter(a => a && typeof a === 'object' && 'image' in a).length,
					expectedVideoCount: array.filter(a => a && typeof a === 'object' && 'video' in a).length
				}
			},
			this.opts({ quoted })
		)

		await this.relayMessage(jid, album.message!, {
			messageId: album.key.id
		})

		for (const item of array) {
			const img = await this.utils.generateWAMessage(jid, item, this.opts())

			if (img.message) {
				img.message.messageContextInfo = {
					messageSecret: randomBytes(32),
					messageAssociation: {
						associationType: 1,
						parentMessageKey: album.key
					}
				} as any
			}

			await this.relayMessage(jid, img.message!, {
				messageId: img.key.id,
				quoted: {
					key: {
						remoteJid: album.key.remoteJid,
						id: album.key.id,
						fromMe: true,
						participant: this.userJid
					},
					message: album.message
				}
			})
		}

		return album
	}

	async handleEvent(content: any, jid: string, quoted?: any) {
		const eventData = content.eventMessage

		const msg = await this.utils.generateWAMessageFromContent(
			jid,
			{
				viewOnceMessage: {
					message: {
						messageContextInfo: {
							deviceListMetadata: {},
							deviceListMetadataVersion: 2,
							messageSecret: randomBytes(32)
						},
						eventMessage: {
							contextInfo: {
								mentionedJid: [jid]
							},
							isCanceled: eventData.isCanceled || false,
							name: eventData.name,
							description: eventData.description,
							location: eventData.location || {
								degreesLatitude: 0,
								degreesLongitude: 0,
								name: 'Location'
							},
							joinLink: eventData.joinLink || '',
							startTime:
								typeof eventData.startTime === 'string'
									? parseInt(eventData.startTime, 10)
									: eventData.startTime || Math.floor(Date.now() / 1000),
							endTime:
								typeof eventData.endTime === 'string'
									? parseInt(eventData.endTime, 10)
									: eventData.endTime || Math.floor(Date.now() / 1000) + 3600,
							extraGuestsAllowed: eventData.extraGuestsAllowed !== false
						}
					}
				}
			},
			this.opts({ quoted })
		)

		await this.relayMessage(jid, msg.message!, {
			messageId: msg.key.id
		})
		return msg
	}

	async handlePollResult(content: any, jid: string, quoted?: any) {
		const pollData = content.pollResultMessage
		const msg = await this.utils.generateWAMessageFromContent(
			jid,
			{
				pollResultSnapshotMessage: {
					name: pollData.name,
					pollVotes: (pollData.pollVotes || pollData.options || []).map((vote: any) => ({
						optionName: vote.optionName,
						optionVoteCount:
							typeof vote.optionVoteCount === 'number'
								? vote.optionVoteCount.toString()
								: vote.optionVoteCount || '0'
					})),
					contextInfo: {
						isForwarded: true,
						forwardingScore: 1,
						forwardedNewsletterMessageInfo: {
							newsletterName: pollData.newsletter?.newsletterName || 'Newsletter',
							newsletterJid: pollData.newsletter?.newsletterJid || '0@newsletter',
							serverMessageId: 1000,
							contentType: 1 as any
						}
					}
				}
			},
			this.opts({ quoted })
		)

		await this.relayMessage(jid, msg.message!, {
			messageId: msg.key.id
		})
		return msg
	}

	async handleOrderMessage(content: any, jid: string, quoted?: any) {
		const orderData = content.orderMessage || content

		const msg = await this.utils.generateWAMessageFromContent(
			jid,
			{
				orderMessage: {
					orderId: orderData.orderId || 'ORDER' + Date.now(),
					thumbnail: orderData.thumbnail || null,
					itemCount: orderData.itemCount || 1,
					status: orderData.status || 'ACCEPTED',
					surface: orderData.surface || 'CATALOG',
					message: orderData.message || orderData.orderTitle || '',
					orderTitle: orderData.orderTitle || 'Order',
					sellerJid: orderData.sellerJid || '0@s.whatsapp.net',
					token: orderData.token || randomBytes(16).toString('hex'),
					totalAmount1000: orderData.totalAmount1000 || 0,
					totalCurrencyCode: orderData.totalCurrencyCode || 'IDR',
					messageVersion: 2
				}
			},
			this.opts({ quoted })
		)

		await this.relayMessage(jid, msg.message!, {
			messageId: msg.key.id
		})
		return msg
	}

	async handleGroupStory(content: any, jid: string, _quoted?: any) {
		const storyData = content.groupStatus
		let messageContent: any

		if (storyData.message) {
			messageContent = storyData
		} else {
			messageContent = await this.utils.generateWAMessageContent(storyData, {
				upload: this.waUploadToServer
			} as any)
		}

		const msg = {
			message: {
				groupStatusMessageV2: {
					message: messageContent.message || messageContent
				}
			}
		}

		return await this.relayMessage(jid, msg.message, {
			messageId: this.utils.generateMessageID()
		})
	}

	async handleGbLabel(content: any, jid: string) {
		const x = content.groupLabel
		if (!isJidGroup(jid)) {
			throw new Error('groupLabel requires a group JID (@g.us)')
		}

		const labelText = typeof x === 'string' ? x : x.labelText || x.label || ''
		const msg = await this.utils.generateWAMessageFromContent(
			jid,
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: {
						label: String(labelText).slice(0, 30)
					}
				}
			},
			this.opts()
		)

		await this.relayMessage(jid, msg.message!, {
			additionalNodes: [
				{
					tag: 'meta',
					attrs: {
						tag_reason: 'user_update',
						appdata: 'member_tag'
					},
					content: undefined
				}
			]
		})
		return msg
	}

	/** Process special content if detected; returns the WAMessage / result or null if not special */
	async process(
		jid: string,
		content: any,
		options: { quoted?: any } = {}
	): Promise<WAMessage | any | null> {
		const type = this.detectType(content)
		if (!type) return null

		const quoted = options.quoted
		switch (type) {
			case 'PAYMENT': {
				const paymentContent = await this.handlePayment(content, quoted)
				const id = this.utils.generateMessageID()
				await this.relayMessage(jid, paymentContent, { messageId: id })
				return { key: { id, remoteJid: jid, fromMe: true }, message: paymentContent }
			}
			case 'PRODUCT': {
				try {
					const productContent = await this.handleProduct(content, jid, quoted)
					const productMsg = await this.utils.generateWAMessageFromContent(
						jid,
						productContent as any,
						this.opts({ quoted })
					)
					if (!productMsg?.message) {
						throw new Error('generateWAMessageFromContent returned empty message')
					}
					// relay isi viewOnce/interactive apa adanya (jangan di-normalize lagi)
					await this.relayMessage(jid, productMsg.message, {
						messageId: productMsg.key?.id
					})
					return productMsg
				} catch (err: any) {
					console.error('[special] PRODUCT failed:', err?.message || err)
					console.error(err?.stack)
					throw err
				}
			}
			case 'ALBUM':
				return await this.handleAlbum(content, jid, quoted)
			case 'EVENT':
				return await this.handleEvent(content, jid, quoted)
			case 'POLL_RESULT':
				return await this.handlePollResult(content, jid, quoted)
			case 'ORDER':
				return await this.handleOrderMessage(content, jid, quoted)
			case 'GROUP_STATUS':
				return await this.handleGroupStory(content, jid, quoted)
			case 'GROUP_LABEL':
				return await this.handleGbLabel(content, jid)
			default:
				return null
		}
	}
}
