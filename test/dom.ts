class TestStyle {
  [key: string]: unknown

  setProperty(name: string, value: string): void {
    this[name] = value
  }

  removeProperty(name: string): void {
    delete this[name]
  }
}

class TestClassList {
  constructor(private readonly element: TestElement) {}

  private tokens(): string[] {
    return this.element.className.split(/\s+/).filter(Boolean)
  }

  contains(token: string): boolean {
    return this.tokens().includes(token)
  }

  add(...tokens: string[]): void {
    this.element.className = [...new Set([...this.tokens(), ...tokens])].join(' ')
  }

  remove(...tokens: string[]): void {
    const rejected = new Set(tokens)
    this.element.className = this.tokens().filter((token) => !rejected.has(token)).join(' ')
  }

  toggle(token: string, force?: boolean): boolean {
    const next = force ?? !this.contains(token)
    if (next) this.add(token)
    else this.remove(token)
    return next
  }
}

class TestNode extends EventTarget {
  parentNode: TestNode | null = null
  childNodes: TestNode[] = []
  private ownText = ''

  /* Needed by any UI that asks "is focus still inside me?" -- the context menu
   * closes on click-away and cannot answer that without it. */
  contains(node: TestNode | null): boolean {
    let cursor = node
    while (cursor) {
      if (cursor === this) return true
      cursor = cursor.parentNode
    }
    return false
  }

  get parentElement(): TestElement | null {
    return this.parentNode instanceof TestElement ? this.parentNode : null
  }

  get children(): TestElement[] {
    return this.childNodes.filter((node): node is TestElement => node instanceof TestElement)
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null
  }

  get textContent(): string {
    if (this.childNodes.length) return this.childNodes.map((node) => node.textContent).join('')
    return this.ownText
  }

  set textContent(value: string) {
    this.ownText = value ?? ''
    this.childNodes = []
  }

  append(...nodes: (TestNode | string)[]): void {
    for (const value of nodes) {
      const node = typeof value === 'string' ? new TestText(value) : value
      if (node.parentNode) node.parentNode.removeChild(node)
      node.parentNode = this
      this.childNodes.push(node)
    }
  }

  appendChild<T extends TestNode>(node: T): T {
    this.append(node)
    return node
  }

  prepend(...nodes: (TestNode | string)[]): void {
    const prepared = nodes.map((value) => (typeof value === 'string' ? new TestText(value) : value))
    for (const node of prepared) {
      if (node.parentNode) node.parentNode.removeChild(node)
      node.parentNode = this
    }
    this.childNodes.unshift(...prepared)
  }

  replaceChildren(...nodes: (TestNode | string)[]): void {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    this.append(...nodes)
  }

  removeChild(node: TestNode): TestNode {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      node.parentNode = null
    }
    return node
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }
}

class TestText extends TestNode {
  constructor(value: string) {
    super()
    this.textContent = value
  }
}

function dataKey(name: string): string {
  return name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function matchesSimple(element: TestElement, selector: string): boolean {
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0]
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false

  const id = selector.match(/#([a-z0-9_-]+)/i)?.[1]
  if (id && element.id !== id) return false

  for (const match of selector.matchAll(/\.([a-z0-9_-]+)/gi)) {
    if (!element.classList.contains(match[1])) return false
  }

  for (const match of selector.matchAll(/\[([a-z0-9_-]+)(?:=["']?([^"'\]]+)["']?)?\]/gi)) {
    const [, name, expected] = match
    const actual = name.startsWith('data-')
      ? element.dataset[dataKey(name)]
      : element.getAttribute(name) ?? String((element as unknown as Record<string, unknown>)[name] ?? '')
    if (expected == null ? actual == null : actual !== expected) return false
  }

  return true
}

function descendants(root: TestNode): TestElement[] {
  const found: TestElement[] = []
  for (const child of root.children) found.push(child, ...descendants(child))
  return found
}

function matchesSelector(element: TestElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/)
  let cursor: TestNode | null = element
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (i === parts.length - 1) {
      if (!(cursor instanceof TestElement) || !matchesSimple(cursor, parts[i])) return false
      cursor = cursor.parentNode
      continue
    }
    while (cursor instanceof TestElement && !matchesSimple(cursor, parts[i])) cursor = cursor.parentNode
    if (!(cursor instanceof TestElement)) return false
    cursor = cursor.parentNode
  }
  return true
}

function testCanvasContext(canvas: TestElement): CanvasRenderingContext2D {
  const gradient = { addColorStop: (_offset: number, _color: string): void => {} }
  const base = {
    canvas: canvas as unknown as HTMLCanvasElement,
    measureText: (text: string) => ({ width: text.length * 24 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_sx: number, _sy: number, sw: number, sh: number) => ({
      data: new Uint8ClampedArray(Math.max(0, sw * sh * 4)),
      width: sw,
      height: sh,
      colorSpace: 'srgb',
    }),
  }
  const noop = (): void => {}
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      return noop
    },
  }) as unknown as CanvasRenderingContext2D
}

class TestElement extends TestNode {
  /* Keyboard-navigable menus move focus themselves. Without this the stub
   * throws instead of recording where focus went. */
  focus(): void {
    ;(globalThis.document as unknown as { activeElement: unknown }).activeElement = this
  }

  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly style = new TestStyle()
  readonly classList = new TestClassList(this)
  className = ''
  id = ''
  hidden = false
  disabled = false
  inert = false
  title = ''
  type = ''
  value = ''
  min = ''
  max = ''
  step = ''
  checked = false
  scrollTop = 0
  innerHTML = ''
  clientWidth = 0
  clientHeight = 0
  width = 0
  height = 0

  get offsetWidth(): number {
    return this.clientWidth
  }

  get offsetHeight(): number {
    return this.clientHeight
  }

  get offsetParent(): TestElement | null {
    return this.hidden ? null : this.parentElement
  }

  constructor(readonly tagName: string) {
    super()
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null
    if (name === 'class') return this.className || null
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name === 'id') this.id = ''
    if (name === 'class') this.className = ''
  }

  querySelectorAll(selector: string): TestElement[] {
    return descendants(this).filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector: string): TestElement | null {
    let cursor: TestElement | null = this
    while (cursor) {
      if (matchesSelector(cursor, selector)) return cursor
      cursor = cursor.parentElement
    }
    return null
  }

  testCanvas2d = false

  getContext(type?: string): CanvasRenderingContext2D | null {
    if (this.testCanvas2d && type === '2d') return testCanvasContext(this)
    return null
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
      toJSON: () => ({}),
    }
  }

  click(): void {
    this.dispatchEvent(new Event('click'))
  }

  scrollIntoView(): void {}
}

class TestDocument extends TestNode {
  readonly documentElement = new TestElement('html')
  readonly body = new TestElement('body')
  activeElement: TestElement | null = null

  constructor(private readonly canvas2d: boolean) {
    super()
    this.append(this.documentElement)
    this.documentElement.append(this.body)
  }

  createElement(tag: string): TestElement {
    const element = new TestElement(tag)
    element.testCanvas2d = this.canvas2d && tag.toLowerCase() === 'canvas'
    return element
  }

  createElementNS(_namespace: string, tag: string): TestElement {
    return new TestElement(tag)
  }

  createTextNode(value: string): TestText {
    return new TestText(value)
  }

  createDocumentFragment(): TestNode {
    return new TestNode()
  }

  getElementById(id: string): TestElement | null {
    return descendants(this).find((element) => element.id === id) ?? null
  }

  querySelectorAll(selector: string): TestElement[] {
    return descendants(this).filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

class TestStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class TestMediaQuery extends EventTarget {
  matches = false
}

class TestWindow extends EventTarget {
  readonly localStorage = new TestStorage()
  readonly location = {
    pathname: '/',
    search: '',
    hash: '',
    assign: (_href: string): void => {},
  }
  readonly history = {
    pushState: (_state: unknown, _unused: string, _url?: string | URL | null): void => {},
    replaceState: (_state: unknown, _unused: string, _url?: string | URL | null): void => {},
  }
  readonly devicePixelRatio = 1
  readonly innerWidth = 1280
  readonly innerHeight = 760

  matchMedia(): TestMediaQuery {
    return new TestMediaQuery()
  }

  setTimeout(fn: () => void, delay?: number): number {
    return globalThis.setTimeout(fn, delay) as unknown as number
  }

  clearTimeout(timer: number): void {
    globalThis.clearTimeout(timer)
  }

  requestAnimationFrame(fn: FrameRequestCallback): number {
    fn(performance.now())
    return 1
  }

  cancelAnimationFrame(_frame: number): void {}
}

export interface TestDom {
  document: TestDocument
  window: TestWindow
  mount(id: string): TestElement
}

export function installTestDom(opts: { canvas2d?: boolean } = {}): TestDom {
  const document = new TestDocument(opts.canvas2d === true)
  const window = new TestWindow()
  const globals: Record<string, unknown> = {
    window,
    document,
    Node: TestNode,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLInputElement: TestElement,
    HTMLSelectElement: TestElement,
    SVGElement: TestElement,
    SVGSVGElement: TestElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }

  return {
    document,
    window,
    mount(id: string) {
      const node = document.createElement('div')
      node.id = id
      /* index.html owns this static entry link; createHud re-parents it into
       * the responsive tool cluster instead of adding bytes to the city chunk. */
      if (id === 'hud-top') {
        const machine = document.createElement('a')
        machine.setAttribute('class', 'pg-btn hud-tool hud-machine')
        machine.setAttribute('href', 'machine/')
        machine.textContent = 'Machine'
        node.append(machine)
      }
      document.body.append(node)
      return node
    },
  }
}
