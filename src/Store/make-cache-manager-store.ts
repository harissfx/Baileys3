// @ts-nocheck
/**
 * Optional auth-state / store backed by cache-manager.
 * Requires the `cache-manager` package to be installed:
 *   npm install cache-manager
 *
 * Ported from pou-code / Baileys-main
 */
import { createRequire } from 'module'
import * as Utils from '../Utils/index.js'
import logger from '../Utils/logger.js'

async function loadCacheManager() {
	try {
		const require = createRequire(import.meta.url)
		return require('cache-manager')
	} catch {
		throw new Error(
			'cache-manager is required for makeCacheManagerStore / makeCacheManagerAuthState. Install it with: npm install cache-manager'
		)
	}
}

export default async function makeCacheManagerAuthState(store: any, sessionKey: string) {
	const cacheManager = await loadCacheManager()
	const defaultKey = (file: string) => `${sessionKey}:${file}`
	const databaseConn = await cacheManager.caching(store)

	const writeData = async (file: string, data: any) => {
		let ttl: number | undefined = undefined
		if (file === 'creds') ttl = 63115200 // 2 years
		await databaseConn.set(defaultKey(file), JSON.stringify(data, Utils.BufferJSON.replacer), ttl)
	}

	const readData = async (file: string) => {
		try {
			const data = await databaseConn.get(defaultKey(file))
			if (data) return JSON.parse(data, Utils.BufferJSON.reviver)
			return null
		} catch (error) {
			logger.error(error)
			return null
		}
	}

	const removeData = async (file: string) => {
		try {
			return await databaseConn.del(defaultKey(file))
		} catch {
			logger.error(`Error removing ${file} from session ${sessionKey}`)
		}
	}

	const clearState = async () => {
		try {
			const result = (await databaseConn.store.keys?.(`${sessionKey}:*`)) || []
			await Promise.all(result.map(async (key: string) => databaseConn.del(key)))
		} catch (error) {
			logger.error(error)
		}
	}

	const creds = (await readData('creds')) || (Utils as any).initAuthCreds?.() || {}

	return {
		state: {
			creds,
			keys: {
				get: async (type: string, ids: string[]) => {
					const data: Record<string, any> = {}
					await Promise.all(
						ids.map(async (id) => {
							let value = await readData(`${type}-${id}`)
							if (type === 'app-state-sync-key' && value) {
								value = (Utils as any).proto?.Message?.AppStateSyncKeyData?.fromObject?.(value) ?? value
							}
							data[id] = value
						})
					)
					return data
				},
				set: async (data: Record<string, any>) => {
					const tasks: Promise<any>[] = []
					for (const category in data) {
						for (const id in data[category]) {
							const value = data[category][id]
							const key = `${category}-${id}`
							tasks.push(value ? writeData(key, value) : removeData(key))
						}
					}
					await Promise.all(tasks)
				}
			}
		},
		saveCreds: async () => {
			await writeData('creds', creds)
		},
		clearState
	}
}
