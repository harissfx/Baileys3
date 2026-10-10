export class ObjectRepository<T = any> {
	private entityMap: Map<string, T>

	constructor(entities: Record<string, T> = {}) {
		this.entityMap = new Map(Object.entries(entities))
	}

	findById(id: string): T | undefined {
		return this.entityMap.get(id)
	}

	findAll(): T[] {
		return Array.from(this.entityMap.values())
	}

	upsertById(id: string, entity: T) {
		this.entityMap.set(id, { ...entity })
	}

	deleteById(id: string) {
		return this.entityMap.delete(id)
	}

	get count() {
		return this.entityMap.size
	}
}

export default ObjectRepository
