interface CleanupTable {
  readonly deadTuples: number
  readonly liveTuples: number
  readonly pages: number
  readonly def: { readonly tuplesPerPage: number }
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
  private readonly cleared: Uint8Array
  private readonly scale: Float64Array
  private readonly observedDead: Float64Array
  private readonly reclaimedTuples: Float64Array
  private readonly collectionDelta: Float64Array
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
    this.cleared = new Uint8Array(tableCount)
    this.scale = new Float64Array(tableCount)
    this.observedDead = new Float64Array(tableCount)
    this.reclaimedTuples = new Float64Array(tableCount)
    this.collectionDelta = new Float64Array(tableCount)
    this.workerActive = new Uint8Array(workerCount)
    this.workerTable = new Int16Array(workerCount)
    this.workerCollected = new Float64Array(workerCount)
    this.workerPhase = Array.from({ length: workerCount }, () => 'idle')
    this.workerTable.fill(-1)
  }

  markerCount(table: number): number {
    return this.markers[table] ?? 0
  }

  displayedSlots(table: number): number {
    return this.markerCount(table) + (this.cleared[table] ?? 0)
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
      this.cleared[table] = 0
      this.observedDead[table] = dead
      this.reclaimedTuples[table] = 0
      this.collectionDelta[table] = 0
    }
    for (let slot = 0; slot < this.workerActive.length; slot++) this.recordWorker(slot, workers[slot])
  }

  sync(tables: readonly CleanupTable[], workers: readonly CleanupWorker[]): void {
    for (let table = 0; table < this.markers.length; table++) {
      const dead = Math.max(0, tables[table]?.deadTuples ?? 0)
      const represented = dead > 0
        ? Math.max(1, Math.min(this.capacity, Math.ceil(dead / this.scale[table])))
        : 0
      if (represented > this.markers[table]) this.markers[table] = represented
      this.collectionDelta[table] = 0
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
        this.collectionDelta[worker.table] += delta
      }
      this.recordWorker(slot, worker)
    }

    for (let table = 0; table < this.markers.length; table++) {
      const relation = tables[table]
      const dead = Math.max(0, relation?.deadTuples ?? 0)
      const decrease = Math.max(0, this.observedDead[table] - dead)
      if (decrease > 0 && this.collectionDelta[table] > 0) {
        this.reclaimedTuples[table] += Math.min(decrease, this.collectionDelta[table])
        this.markers[table] = dead > 0
          ? Math.max(1, Math.min(this.capacity, Math.ceil(dead / this.scale[table])))
          : 0
      }
      const aggregateFree = Math.max(0,
        (relation?.pages ?? 0) * (relation?.def.tuplesPerPage ?? 0)
          - (relation?.liveTuples ?? 0) - dead)
      const reusable = Math.min(
        Math.floor(this.reclaimedTuples[table] / this.scale[table]),
        Math.floor(aggregateFree / this.scale[table]),
      )
      this.cleared[table] = Math.max(0, Math.min(this.capacity - this.markers[table], reusable))
      this.observedDead[table] = dead
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
    this.cleared[table] = 0
    this.observedDead[table] = Math.max(0, dead)
    this.reclaimedTuples[table] = 0
    this.collectionDelta[table] = 0
  }
}
