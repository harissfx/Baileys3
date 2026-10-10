export default function makeOrderedDictionary<T = any>(idGetter: (item: T) => string) {
	const array: T[] = []
	const dict: Record<string, T> = {}

	const get = (id: string): T | undefined => dict[id]

	const update = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array[idx] = item
			dict[id] = item
			return true
		}
		return false
	}

	const upsert = (item: T, mode: 'append' | 'prepend' = 'append') => {
		const id = idGetter(item)
		if (get(id)) {
			update(item)
		} else {
			if (mode === 'append') array.push(item)
			else array.unshift(item)
			dict[id] = item
		}
	}

	const remove = (item: T) => {
		const id = idGetter(item)
		const idx = array.findIndex(i => idGetter(i) === id)
		if (idx >= 0) {
			array.splice(idx, 1)
			delete dict[id]
			return true
		}
		return false
	}

	return {
		array,
		get,
		update,
		upsert,
		remove,
		updateAssign: (id: string, updateObj: Partial<T>) => {
			const item = dict[id]
			if (!item) return false
			Object.assign(item as object, updateObj)
			delete dict[id]
			dict[idGetter(item)] = item
			return true
		},
		clear: () => {
			array.splice(0, array.length)
			for (const key of Object.keys(dict)) delete dict[key]
		},
		filter: (contain: (item: T) => boolean) => {
			for (let i = array.length - 1; i >= 0; i--) {
				if (!contain(array[i]!)) {
					delete dict[idGetter(array[i]!)]
					array.splice(i, 1)
				}
			}
		},
		toJSON: () => array,
		fromJSON: (newItems: T[]) => {
			array.splice(0, array.length, ...newItems)
			for (const key of Object.keys(dict)) delete dict[key]
			for (const item of newItems) {
				dict[idGetter(item)] = item
			}
		}
	}
}
