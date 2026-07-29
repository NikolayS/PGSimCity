import { parseExplainJson } from '../src/observability/explain-json.ts'

export async function loadRealPostgres() {
  const runtime = await import('../src/observability/real-postgres-runtime.ts')
  return runtime.createPgliteSource(parseExplainJson)
}
