import { readFileSync } from 'node:fs'
import path from 'node:path'

function valueOf(raw) {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value.replace(/\s+#.*$/, '')
}

export function loadEnvFile(filePath = path.resolve(process.cwd(), '.env'), env = process.env) {
  let contents
  try {
    contents = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match && env[match[1]] === undefined) env[match[1]] = valueOf(match[2])
  }
  return true
}

loadEnvFile()
