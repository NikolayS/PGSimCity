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

class TestElement extends TestNode {
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

  querySelectorAll(selector: string): TestElement[] {
    return descendants(this).filter((element) => matchesSelector(element, selector))
  }

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  click(): void {
    this.dispatchEvent(new Event('click'))
  }
}

class TestDocument extends TestNode {
  readonly body = new TestElement('body')

  constructor() {
    super()
    this.append(this.body)
  }

  createElement(tag: string): TestElement {
    return new TestElement(tag)
  }

  createElementNS(_namespace: string, tag: string): TestElement {
    return new TestElement(tag)
  }

  createTextNode(value: string): TestText {
    return new TestText(value)
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
  readonly location = { pathname: '/', search: '', hash: '' }

  matchMedia(): TestMediaQuery {
    return new TestMediaQuery()
  }
}

export interface TestDom {
  document: TestDocument
  window: TestWindow
  mount(id: string): TestElement
}

export function installTestDom(): TestDom {
  const document = new TestDocument()
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
      document.body.append(node)
      return node
    },
  }
}
