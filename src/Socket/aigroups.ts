import type { GroupMetadata, ParticipantAction, SocketConfig } from '../Types/index.js'
import { WAMessageAddressingMode } from '../Types/index.js'
import { generateMessageIDV2 } from '../Utils/index.js'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isLidUser,
	isPnUser,
	jidEncode,
	jidNormalizedUser
} from '../WABinary/index.js'
import { makeGroupsSocket } from './groups.js'

/** Metadata grup AI = metadata grup biasa + penanda isAIGroup */
export type AIGroupMetadata = GroupMetadata & { isAIGroup: true }

export interface AIGroupCreateOptions {
	ephemeralExpiration?: number
	memberAddMode?: string
	memberShareGroupHistoryMode?: string
	memberLinkMode?: string
}

// ID bot Meta AI default
const DEFAULT_META_AI_BOT_USER = '867051314767696'

export const makeAIGroupsSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query } = sock

	/** Query helper untuk grup AI (xmlns w:g2) */
	const aiGroupQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})

	const aiGroupMetadata = async (jid: string) => {
		const result = await aiGroupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		return extractAIGroupMetadata(result)
	}

	return {
		...sock,
		aiGroupMetadata,
		aiGroupCreate: async (subject: string, participants: string[] = [], _options: AIGroupCreateOptions = {}) => {
			if (!Array.isArray(participants)) participants = []
			const key = generateMessageIDV2()
			const result = await aiGroupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			return extractAIGroupMetadata(result)
		},
		aiGroupAddBot: async (jid: string, botUser: string = DEFAULT_META_AI_BOT_USER) => {
			const result = await aiGroupQuery(jid, 'set', [
				{
					tag: 'add',
					attrs: {},
					content: [
						{
							tag: 'participant',
							attrs: { jid: `${botUser}@bot` }
						}
					]
				}
			])
			const node = getBinaryNodeChild(result, 'add')
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => ({
				status: p.attrs.error || '200',
				jid: p.attrs.jid
			}))
		},
		aiGroupLeave: async (id: string) => {
			await aiGroupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }]
				}
			])
		},
		aiGroupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			const result = await aiGroupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => ({
				status: p.attrs.error || '200',
				jid: p.attrs.jid,
				content: p
			}))
		},
		aiGroupUpdateSubject: async (jid: string, subject: string) => {
			await aiGroupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		aiGroupInviteCode: async (jid: string) => {
			const result = await aiGroupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		aiGroupRevokeInvite: async (jid: string) => {
			const result = await aiGroupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		aiGroupAcceptInvite: async (code: string) => {
			const results = await aiGroupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'group')
			return result?.attrs.jid
		},
		aiGroupSettingUpdate: async (jid: string, setting: string) => {
			await aiGroupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		aiGroupToggleEphemeral: async (jid: string, ephemeralExpiration?: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await aiGroupQuery(jid, 'set', [content])
		}
	}
}

export const extractAIGroupMetadata = (result: BinaryNode): AIGroupMetadata => {
	// Respons IQ menaruh group di dalam node create: result → create → group
	const createNode = getBinaryNodeChild(result, 'create')
	const group = (getBinaryNodeChild(createNode || result, 'group') || getBinaryNodeChild(result, 'group'))!
	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPn: string | undefined
	let descTime: number | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descTime = +descChild.attrs.t!
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id!.includes('@') ? group.attrs.id! : jidEncode(group.attrs.id!, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const metadata = {
		id: groupId,
		subject: group.attrs.subject,
		subjectTime: +group.attrs.s_t!,
		creation: +group.attrs.creation!,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		owner_country_code: group.attrs.creator_country_code,
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descTime,
		isAIGroup: true,
		addressingMode:
			group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => ({
			id: attrs.jid!,
			phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
			lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
			admin: (attrs.type || null) as 'admin' | 'superadmin' | null
		})),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata as unknown as AIGroupMetadata
}

export type AIGroupsSocket = ReturnType<typeof makeAIGroupsSocket>
