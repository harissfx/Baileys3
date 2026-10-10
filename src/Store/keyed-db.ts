type CompareFn = (a: string, b: string) => number
type IdGetter<T> = (entry: T) => string

export default class KeyedDB<T = any> {
	private _compare: CompareFn
	private _idGetter: IdGetter<T>
	private _array: T[]
	private _dict: Record<string, T>

	constructor(compareFn: CompareFn, idGetter: IdGetter<T>) {
		this._compare = compareFn
		this._idGetter = idGetter
		this._array = []
		this._dict = {}
	}

	get length() {
		return this._array.length
	}

	get(id: string): T | undefined {
		return this._dict[id]
	}

	insert(entry: T, _mode = 'insert') {
		const id = this._idGetter(entry)
		this._dict[id] = entry
		let inserted = false
		for (let i = 0; i < this._array.length; i++) {
			const cmp = this._compare(this._idGetter(this._array[i]!), id)
			if (cmp > 0) {
				this._array.splice(i, 0, entry)
				inserted = true
				break
			}
		}
		if (!inserted) this._array.push(entry)
		return true
	}

	insertIfAbsent(...entries: T[]) {
		for (const entry of entries) {
			if (!this._dict[this._idGetter(entry)]) {
				this.insert(entry)
			}
		}
	}

	upsert(...entries: T[]) {
		for (const entry of entries) {
			const id = this._idGetter(entry)
			if (this._dict[id]) {
				const idx = this._array.findIndex(e => this._idGetter(e) === id)
				if (idx >= 0) this._array[idx] = entry
				this._dict[id] = entry
			} else {
				this.insert(entry)
			}
		}
	}

	update(id: string, updater: (item: T) => void) {
		const item = this._dict[id]
		if (!item) return false
		updater(item)
		const idx = this._array.findIndex(e => this._idGetter(e) === id)
		if (idx >= 0) this._array[idx] = item
		return true
	}

	updateAssign(id: string, update: Partial<T>) {
		const item = this._dict[id]
		if (!item) return false
		Object.assign(item as object, update)
		const idx = this._array.findIndex(e => this._idGetter(e) === id)
		if (idx >= 0) this._array[idx] = item
		return true
	}

	deleteById(id: string) {
		if (!this._dict[id]) return false
		delete this._dict[id]
		const idx = this._array.findIndex(e => this._idGetter(e) === id)
		if (idx >= 0) this._array.splice(idx, 1)
		return true
	}

	/** alias used by make-in-memory-store */
	delete(entry: T | string) {
		const id = typeof entry === 'string' ? entry : this._idGetter(entry)
		return this.deleteById(id)
	}

	clear() {
		this._array = []
		this._dict = {}
	}

	all() {
		return [...this._array]
	}

	filter(predicate: (entry: T) => boolean) {
		this._array = this._array.filter(predicate)
		this._dict = {}
		for (const entry of this._array) {
			this._dict[this._idGetter(entry)] = entry
		}
	}

	get count() {
		return this._array.length
	}

	toJSON() {
		return this._array
	}

	fromJSON(array: T[]) {
		this.clear()
		for (const entry of array) {
			this.insert(entry)
		}
	}

	[Symbol.iterator]() {
		return this._array[Symbol.iterator]()
	}
}
