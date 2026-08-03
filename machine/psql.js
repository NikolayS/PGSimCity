const NUMERIC_TYPE_IDS = new Set([
  20, // int8
  21, // int2
  23, // int4
  26, // oid
  700, // float4
  701, // float8
  790, // money
  1700, // numeric
])

function countLabel(count) {
  return `(${count} ${count === 1 ? 'row' : 'rows'})`
}

function centered(value, width) {
  const empty = Math.max(0, width - value.length)
  const left = Math.floor(empty / 2)
  return `${' '.repeat(left)}${value}${' '.repeat(empty - left)}`
}

function asText(value) {
  if (value === null || value === undefined) return ''
  if (value === true) return 't'
  if (value === false) return 'f'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function rowValues(fields, row) {
  return fields.map((field) => asText(row[field.name]))
}

function formatExpanded(fields, rows, maxWidth) {
  if (rows.length === 0) return countLabel(0)
  const nameWidth = Math.max(...fields.map((field) => field.name.length), 1)
  const lines = []

  rows.forEach((row, index) => {
    const values = rowValues(fields, row)
    const dividerWidth = Math.max(
      18,
      Math.min(
        maxWidth,
        nameWidth + 3 + Math.max(...values.map((value) => value.length), 0),
      ),
    )
    const record = `-[ RECORD ${index + 1} ]`
    lines.push(`${record}${'-'.repeat(Math.max(0, dividerWidth - record.length))}`)
    fields.forEach((field, fieldIndex) => {
      const parts = values[fieldIndex].split('\n')
      lines.push(`${field.name.padEnd(nameWidth)} | ${parts[0]}`)
      for (const part of parts.slice(1)) {
        lines.push(`${' '.repeat(nameWidth)} | ${part}`)
      }
    })
  })
  return lines.join('\n')
}

export function formatResult(fields, rows, options = {}) {
  const maxWidth = Math.max(18, options.maxWidth ?? 72)
  if (fields.length === 0) return countLabel(rows.length)

  const values = rows.map((row) => rowValues(fields, row))
  const widths = fields.map((field, index) =>
    Math.max(
      field.name.length,
      ...values.map((row) => row[index].length),
    ))
  const tableWidth =
    widths.reduce((total, width) => total + width + 2, 0)
    + Math.max(0, fields.length - 1)

  if (options.expanded || tableWidth > maxWidth) {
    return formatExpanded(fields, rows, maxWidth)
  }

  const header = fields
    .map((field, index) => ` ${centered(field.name, widths[index])} `)
    .join('|')
    .trimEnd()
  const separator = widths.map((width) => '-'.repeat(width + 2)).join('+')
  const body = values.map((row) =>
    row
      .map((value, index) => {
        const aligned = NUMERIC_TYPE_IDS.has(fields[index].dataTypeId)
          ? value.padStart(widths[index])
          : value.padEnd(widths[index])
        return ` ${aligned} `
      })
      .join('|')
      .trimEnd())

  const lines = [header, separator, ...body]
  if (options.footer !== false) lines.push(countLabel(rows.length))
  return lines.join('\n')
}

export function formatError(error, sql) {
  const severity = error.severity || 'ERROR'
  const lines = [`${severity}:  ${error.message}`]
  if (error.detail) lines.push(`DETAIL:  ${error.detail}`)
  if (error.hint) lines.push(`HINT:  ${error.hint}`)

  const position = Number(error.position)
  if (Number.isInteger(position) && position > 0 && sql) {
    const offset = Math.min(sql.length, position - 1)
    const before = sql.slice(0, offset)
    const lineNumber = before.split('\n').length
    const lineStart = before.lastIndexOf('\n') + 1
    const lineEndAt = sql.indexOf('\n', offset)
    const lineEnd = lineEndAt === -1 ? sql.length : lineEndAt
    const sourceLine = sql.slice(lineStart, lineEnd)
    const prefix = `LINE ${lineNumber}: `
    lines.push(`${prefix}${sourceLine}`)
    lines.push(`${' '.repeat(prefix.length + offset - lineStart)}^`)
  }

  return lines.join('\n')
}

export function formatReport(report, options = {}) {
  if (report.error) return formatError(report.error, report.sql)
  const blocks = []
  for (const result of report.results) {
    if (result.fields.length > 0) {
      blocks.push(formatResult(result.fields, result.rows, options))
    }
  }

  const command = /^[\s(]*(\w+)/u.exec(report.sql)?.[1]?.toUpperCase() ?? ''
  const affected = report.results.at(-1)?.affectedRows
  if (
    affected !== null
    && affected !== undefined
    && ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'MOVE', 'FETCH', 'COPY'].includes(command)
  ) {
    blocks.push(command === 'INSERT' ? `INSERT 0 ${affected}` : `${command} ${affected}`)
  } else if (blocks.length === 0) {
    blocks.push(command || 'OK')
  }

  return blocks.join('\n\n')
}

export function formatDescribeIndex(row) {
  const using = String(row.Definition).split(' USING ')[1] ?? row.Definition
  const kind = row.Primary ? ' PRIMARY KEY,' : row.Unique ? ' UNIQUE,' : ''
  const validity = row.Valid ? '' : ' INVALID'
  return `    "${row.Name}"${kind} ${using}${validity}`
}

export function parseMetaCommand(input) {
  const match = /^\\([^\s]+)(?:\s+([\s\S]*))?$/u.exec(input.trim())
  if (!match) return null
  const name = match[1]
  const argument = match[2]?.trim() ?? ''
  if (name === 'd' || name === 'd+' || name === 'dt' || name === 'timing') {
    return { command: name, argument }
  }
  return { command: 'invalid', argument: name }
}
