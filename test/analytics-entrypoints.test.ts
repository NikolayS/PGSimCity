import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entrypoint = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const ownerSnippet = `<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-8M-ssImnj4YBtK34iZRwy.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>`

describe('analytics entry points', () => {
  it.each([
    ['city', 'index.html'],
    ['observability', 'observability/index.html'],
  ])('installs the owner-provided tracker snippet verbatim on %s', (_name, path) => {
    const html = entrypoint(path)

    expect(html).toContain(ownerSnippet)
    expect(html).not.toContain('script.pageview-props.js')
    expect(html).not.toContain('data-domain=')
    expect(html).not.toContain('plausible.io/api/event')
  })
})
