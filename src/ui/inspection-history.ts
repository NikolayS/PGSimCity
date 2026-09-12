const DEFAULT_LIMIT = 12

/** Session-only navigation for the inspector; component visits never touch the model. */
export class InspectionHistory {
  private readonly previous: string[] = []
  private current: string | null = null

  constructor(private readonly limit = DEFAULT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('inspection history limit must be a positive integer')
  }

  get canGoBack(): boolean {
    return this.previous.length > 0
  }

  visit(id: string): void {
    if (id === this.current) return
    if (this.current) {
      const repeated = this.previous.indexOf(this.current)
      if (repeated >= 0) this.previous.splice(repeated, 1)
      this.previous.push(this.current)
      if (this.previous.length > this.limit) this.previous.splice(0, this.previous.length - this.limit)
    }
    const destination = this.previous.indexOf(id)
    if (destination >= 0) this.previous.splice(destination, 1)
    this.current = id
  }

  back(): string | null {
    const id = this.previous.pop() ?? null
    if (id) this.current = id
    return id
  }

  reset(): void {
    this.previous.length = 0
    this.current = null
  }
}
