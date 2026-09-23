import { mkdir, readdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types/index.js'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'

export type UseSqliteAuthStateOptions = {
	/** file name for the database, used when `pathOrFolder` is a folder. Default: `auth.db` */
	fileName?: string
	/** legacy `useMultiFileAuthState` folder to migrate from, if the DB has no creds yet */
	migrateFromFolder?: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	logger?: any
}

/**
 * Stores the full authentication state in a single SQLite database file, using Node's
 * built-in `node:sqlite` module (requires Node 22.5+).
 *
 * Ported from the `@vansnowi/baileys` fork.
 *
 * @param pathOrFolder either a full path to the `.db`/`.sqlite`/`.sqlite3` file, or a folder
 * (in which case `fileName` is appended to it)
 */
export const useSqliteAuthState = async (
	pathOrFolder: string,
	options: UseSqliteAuthStateOptions = {}
): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	db: any
	close: () => void
}> => {
	const { fileName = 'auth.db', migrateFromFolder, logger } = options

	const dbPath = /\.(db|sqlite|sqlite3)$/i.test(pathOrFolder) ? pathOrFolder : join(pathOrFolder, fileName)

	const encode = (value: unknown): Buffer => {
		if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
			return Buffer.concat([Buffer.from([1]), Buffer.from(value)])
		}

		return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8')])
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const decode = (blob: Uint8Array | null | undefined): any => {
		if (!blob || blob.length === 0) return null
		if (blob[0] === 1) return Buffer.from(blob.subarray(1))
		return JSON.parse(Buffer.from(blob.subarray(1)).toString('utf8'), BufferJSON.reviver)
	}

	const fixName = (s: string) => s?.replace(/\//g, '__')?.replace(/:/g, '-')
	const keyOf = (category: string, id: string) => fixName(`${category}-${id}`)

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let DatabaseSync: any
	try {
		;({ DatabaseSync } = await import("node:sqlite"))
	} catch (err) {
		throw new Error(
			"useSqliteAuthState needs the built-in 'node:sqlite' module (Node 22.5+). Upgrade Node, or use useMultiFileAuthState instead."
		)
	}

	await mkdir(dirname(dbPath), { recursive: true }).catch(() => {})

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const db: any = new DatabaseSync(dbPath)
	db.exec('PRAGMA journal_mode = TRUNCATE')
	db.exec('PRAGMA synchronous = NORMAL')
	db.exec('PRAGMA busy_timeout = 5000')
	db.exec('CREATE TABLE IF NOT EXISTS auth_state (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID')

	const qGet = db.prepare('SELECT v FROM auth_state WHERE k = ?')
	const qUpsert = db.prepare('INSERT INTO auth_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
	const qDelete = db.prepare('DELETE FROM auth_state WHERE k = ?')

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const runTx = <T>(fn: () => T): T => {
		db.exec('BEGIN')
		try {
			const r = fn()
			db.exec('COMMIT')
			return r
		} catch (err) {
			db.exec('ROLLBACK')
			throw err
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const readRaw = (k: string): any => {
		const row = qGet.get(k)
		if (!row) return null
		try {
			return decode(row.v)
		} catch (err: any) {
			logger?.warn?.({ k, err: err?.message }, 'sqlite-auth: failed to decode row, treating as missing')
			return null
		}
	}

	const runMigration = async (folder: string): Promise<number> => {
		let files: string[]
		try {
			files = await readdir(folder)
		} catch {
			return 0
		}

		const rows: Array<[string, Buffer]> = []
		for (const file of files) {
			if (!file.endsWith('.json')) continue

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let value: any
			try {
				value = JSON.parse(await readFile(join(folder, file), 'utf8'), BufferJSON.reviver)
			} catch {
				continue
			}

			if (value === null || value === undefined) continue
			rows.push([file.slice(0, -'.json'.length), encode(value)])
		}

		runTx(() => {
			for (const [k, v] of rows) qUpsert.run(k, v)
		})

		return rows.length
	}

	const hasCreds = () => !!qGet.get('creds')

	if (migrateFromFolder && !hasCreds()) {
		const n = await runMigration(migrateFromFolder)
		if (n > 0) logger?.info?.({ count: n, from: migrateFromFolder }, 'sqlite-auth: migrated legacy auth state')
	}

	let creds: AuthenticationCreds = readRaw('creds')
	if (!creds) {
		creds = initAuthCreds()
		qUpsert.run('creds', encode(creds))
	}

	const keys: AuthenticationState['keys'] = {
		get: async (type, ids) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				let value = readRaw(keyOf(type, id))
				if (type === 'app-state-sync-key' && value) {
					value = proto.Message.AppStateSyncKeyData.fromObject(value)
				}

				if (value !== null && value !== undefined) {
					data[id] = value
				}
			}

			return data
		},
		set: async data => {
			const ops: Array<[string, unknown]> = []
			for (const category in data) {
				for (const id in data[category as keyof SignalDataTypeMap]) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					ops.push([keyOf(category, id), (data as any)[category][id]])
				}
			}

			runTx(() => {
				for (const [k, value] of ops) {
					if (value === null || value === undefined) qDelete.run(k)
					else qUpsert.run(k, encode(value))
				}
			})
		},
		clear: async () => {
			db.prepare("DELETE FROM auth_state WHERE k <> 'creds'").run()
		}
	}

	return {
		state: { creds, keys },
		saveCreds: async () => {
			qUpsert.run('creds', encode(creds))
		},
		db,
		close: () => db.close()
	}
}
