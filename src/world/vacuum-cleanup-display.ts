interface CleanupTable {
  readonly deadTuples: number
}

interface CleanupWorker {
  readonly active: boolean
  readonly table: number
  readonly phase: string
  readonly deadCollected: number
}

/** Allocation-free, presentation-only accounting for the aggregate cleanup strips. */
export class VacuumCleanupDisplay {
  private readonly markers: Uint8Array
  private readonly scale: Float64Array
  private readonly observedDead: Float64Array
  private readonly growthRemainder: Float64Array
  private readonly removalRemainder: Float64Array
  private readonly workerActive: Uint8Array
  private readonly workerTable: Int16Array
  private readonly workerCollected: Float64Array
  private readonly workerPhase: string[]

  constructor(
    tableCount: number,
    workerCount: number,
    readonly capacity: number,
  ) {
    this.markers = new Uint8Array(tableCount)
    this.scale = new Float64Array(tableCount)
    this.observedDead = new Float64Array(tableCount)
    this.growthRemainder = new Float64Array(tableCount)
    this.removalRemainder = new Float64Array(tableCount)
    this.workerActive = new Uint8Array(workerCount)
    this.workerTable = new Int16Array(workerCount)
    this.workerCollected = new Float64Array(workerCount)
    this.workerPhase = Array.from({ length: workerCount }, () => 'idle')
    this.workerTable.fill(-1)
  }

  markerCount(table: number): number {
    return this.markers[table] ?? 0
  }

  tuplesPerMarker(table: number): number {
    return this.scale[table] ?? 1
  }

  reset(tables: readonly CleanupTable[], workers: readonly CleanupWorker[]): void {
    for (let table = 0; table < this.markers.length; table++) {
      const dead = Math.max(0, tables[table]?.deadTuples ?? 0)
      const scale = Math.max(1, Math.ceil(dead / this.capacity))
      this.scale[table] = scale
      this.markers[table] = Math.min(this.capacity, Math.ceil(dead / scale))
      this.observedDead[table] = dead
      this.growthRemainder[table] = 0
      this.removalRemainder[table] = 0
    }
    for (let slot = 0; slot < this.workerActive.length; slot++) this.recordWorker(slot, workers[slot])
  }

  sync(tables: readonly CleanupTable[], workers: readonly CleanupWorker[]): void {
    for (let table = 0; table < this.markers.length; table++) {
      const dead = Math.max(0, tables[table]?.deadTuples ?? 0)
      const growth = dead - this.observedDead[table]
      if (growth > 0) {
        this.growthRemainder[table] += growth
        const added = Math.floor(this.growthRemainder[table] / this.scale[table])
        if (added > 0) {
          this.markers[table] = Math.min(this.capacity, this.markers[table] + added)
          this.growthRemainder[table] -= added * this.scale[table]
        }
      }
      this.observedDead[table] = dead
    }

    for (let slot = 0; slot < this.workerActive.length; slot++) {
      const worker = workers[slot]
      if (!worker) continue
      const sameTask = this.workerActive[slot] !== 0
        && this.workerTable[slot] === worker.table
      const counterReset = worker.deadCollected < this.workerCollected[slot]
      const newTask = worker.active && (!sameTask || counterReset)
      if (newTask && worker.table >= 0 && worker.table < this.markers.length) {
        const baseline = Math.max(0, (tables[worker.table]?.deadTuples ?? 0) + worker.deadCollected)
        this.rebase(worker.table, baseline)
      }
      const delta = worker.deadCollected - this.workerCollected[slot]
      const collectionPhase = worker.phase === 'vacuum_heap' || this.workerPhase[slot] === 'vacuum_heap'
      if (sameTask && !counterReset && collectionPhase && delta > 0 && worker.table >= 0 && worker.table < this.markers.length) {
        const table = worker.table
        this.removalRemainder[table] += delta
        const removed = Math.floor(this.removalRemainder[table] / this.scale[table])
        if (removed > 0 || (tables[table]?.deadTuples ?? 0) <= 0) {
          const floor = (tables[table]?.deadTuples ?? 0) > 0 ? 1 : 0
          this.markers[table] = Math.max(floor, this.markers[table] - removed)
          if (floor === 0) this.markers[table] = 0
          this.removalRemainder[table] -= removed * this.scale[table]
        }
      }
      this.recordWorker(slot, worker)
    }
  }

  private recordWorker(slot: number, worker: CleanupWorker | undefined): void {
    this.workerActive[slot] = worker?.active ? 1 : 0
    this.workerTable[slot] = worker?.table ?? -1
    this.workerCollected[slot] = Math.max(0, worker?.deadCollected ?? 0)
    this.workerPhase[slot] = worker?.phase ?? 'idle'
  }

  private rebase(table: number, dead: number): void {
    const scale = Math.max(1, Math.ceil(dead / this.capacity))
    this.scale[table] = scale
    this.markers[table] = Math.min(this.capacity, Math.ceil(dead / scale))
    this.observedDead[table] = Math.max(0, dead)
    this.growthRemainder[table] = 0
    this.removalRemainder[table] = 0
  }
}
