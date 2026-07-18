const DEFAULT_MAX_NORMALIZATION_DEPTH = 16
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const JSON_NUMBER_COMPONENT_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

type JsonObject = Record<string, unknown>

interface NormalizationContext {
  readonly rootSchema: unknown
  readonly maximumDepth: number
  readonly activeValues: WeakSet<object>
}

interface SchemaAnalysis {
  readonly nodes: readonly JsonObject[]
  readonly types: ReadonlySet<string>
}

interface DecimalRepresentation {
  readonly negative: boolean
  readonly digits: string
  readonly exponent: number
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function localSchemaReference(rootSchema: unknown, reference: string): unknown {
  if (reference === '#') return rootSchema
  if (!reference.startsWith('#/')) return undefined

  let current = rootSchema
  for (const encodedSegment of reference.slice(2).split('/')) {
    if (!isJsonObject(current)) return undefined
    let decodedSegment: string
    try {
      decodedSegment = decodeURIComponent(encodedSegment)
    } catch {
      return undefined
    }
    const segment = decodedSegment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function sameJsonValue(
  left: unknown,
  right: unknown,
  maximumDepth: number,
  depth = 0,
  visited = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true
  if (depth >= maximumDepth || typeof left !== 'object' || typeof right !== 'object') return false
  if (left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return false

  const previous = visited.get(left)
  if (previous?.has(right)) return true
  if (previous) previous.add(right)
  else visited.set(left, new WeakSet([right]))

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((entry, index) =>
      sameJsonValue(entry, right[index], maximumDepth, depth + 1, visited),
    )
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false
  const leftNames = Object.keys(left)
  const rightNames = Object.keys(right)
  if (leftNames.length !== rightNames.length) return false
  return leftNames.every(
    (name) =>
      Object.hasOwn(right, name) &&
      sameJsonValue(left[name], right[name], maximumDepth, depth + 1, visited),
  )
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isJsonObject(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    default:
      return true
  }
}

function schemaCouldAccept(
  value: unknown,
  schema: unknown,
  rootSchema: unknown,
  maximumDepth: number,
  depth = 0,
  visited = new Set<object>(),
): boolean {
  if (schema === true) return true
  if (schema === false) return false
  if (depth >= maximumDepth || !isJsonObject(schema) || visited.has(schema)) return true
  visited.add(schema)
  try {
    const declaredTypes =
      typeof schema.type === 'string'
        ? [schema.type]
        : Array.isArray(schema.type)
          ? schema.type.filter((entry): entry is string => typeof entry === 'string')
          : []
    if (
      declaredTypes.length > 0 &&
      !(value === null && schema.nullable === true) &&
      !declaredTypes.some((type) => valueMatchesType(value, type))
    ) {
      return false
    }
    if (
      Object.hasOwn(schema, 'const') &&
      !sameJsonValue(value, schema.const, maximumDepth - depth)
    ) {
      return false
    }
    if (
      Array.isArray(schema.enum) &&
      !schema.enum.some((entry) => sameJsonValue(value, entry, maximumDepth - depth))
    ) {
      return false
    }

    if (typeof schema.$ref === 'string') {
      const referenced = localSchemaReference(rootSchema, schema.$ref)
      if (
        referenced !== undefined &&
        !schemaCouldAccept(value, referenced, rootSchema, maximumDepth, depth + 1, visited)
      ) {
        return false
      }
    }
    if (
      Array.isArray(schema.allOf) &&
      schema.allOf.some(
        (branch) => !schemaCouldAccept(value, branch, rootSchema, maximumDepth, depth + 1, visited),
      )
    ) {
      return false
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const branches = schema[keyword]
      if (
        Array.isArray(branches) &&
        !branches.some((branch) =>
          schemaCouldAccept(value, branch, rootSchema, maximumDepth, depth + 1, visited),
        )
      ) {
        return false
      }
    }

    if (Array.isArray(value)) {
      const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : []
      for (let index = 0; index < value.length; index += 1) {
        const itemSchema = index < prefixItems.length ? prefixItems[index] : schema.items
        if (
          itemSchema !== undefined &&
          !schemaCouldAccept(value[index], itemSchema, rootSchema, maximumDepth, depth + 1, visited)
        ) {
          return false
        }
      }
    }

    if (isJsonObject(value)) {
      const properties = isJsonObject(schema.properties) ? schema.properties : undefined
      if (
        Array.isArray(schema.required) &&
        schema.required.some((name) => typeof name === 'string' && !Object.hasOwn(value, name))
      ) {
        return false
      }
      if (properties) {
        for (const [name, propertySchema] of Object.entries(properties)) {
          if (
            Object.hasOwn(value, name) &&
            !schemaCouldAccept(
              value[name],
              propertySchema,
              rootSchema,
              maximumDepth,
              depth + 1,
              visited,
            )
          ) {
            return false
          }
        }
      }
      if (schema.additionalProperties === false && !isJsonObject(schema.patternProperties)) {
        for (const name of Object.keys(value)) {
          if (!properties || !Object.hasOwn(properties, name)) return false
        }
      }
    }
    return true
  } finally {
    visited.delete(schema)
  }
}

function analyzeSchema(schema: unknown, rootSchema: unknown, maximumDepth: number): SchemaAnalysis {
  const nodes: JsonObject[] = []
  const types = new Set<string>()
  const visited = new Set<object>()

  const visit = (candidate: unknown, depth: number): void => {
    if (depth >= maximumDepth || !isJsonObject(candidate) || visited.has(candidate)) return
    visited.add(candidate)
    nodes.push(candidate)

    const type = candidate.type
    if (typeof type === 'string') types.add(type)
    if (Array.isArray(type)) {
      for (const entry of type) {
        if (typeof entry === 'string') types.add(entry)
      }
    }
    if (candidate.nullable === true || candidate.const === null) types.add('null')
    if (Array.isArray(candidate.enum) && candidate.enum.includes(null)) types.add('null')

    if (typeof candidate.$ref === 'string') {
      visit(localSchemaReference(rootSchema, candidate.$ref), depth + 1)
    }
    const allOf = candidate.allOf
    if (Array.isArray(allOf)) {
      for (const branch of allOf) visit(branch, depth + 1)
    }
  }

  visit(schema, 0)
  return { nodes, types }
}

function combinedSchema(schemas: readonly unknown[]): unknown {
  if (schemas.length === 0) return undefined
  if (schemas.length === 1) return schemas[0]
  return { allOf: schemas }
}

function canonicalDecimal(value: string): DecimalRepresentation | null {
  const match = JSON_NUMBER_COMPONENT_PATTERN.exec(value)
  if (!match) return null
  const fraction = match[3] ?? ''
  const rawExponent = match[4] ?? '0'
  const parsedExponent = Number(rawExponent)
  if (!Number.isSafeInteger(parsedExponent)) return null

  let exponent = parsedExponent - fraction.length
  if (!Number.isSafeInteger(exponent)) return null
  let digits = `${match[2]}${fraction}`.replace(/^0+/, '')
  if (!digits) {
    return { negative: match[1] === '-', digits: '0', exponent: 0 }
  }
  const withoutTrailingZeroes = digits.replace(/0+$/, '')
  exponent += digits.length - withoutTrailingZeroes.length
  if (!Number.isSafeInteger(exponent)) return null
  digits = withoutTrailingZeroes
  return { negative: match[1] === '-', digits, exponent }
}

function exactJsonNumber(value: string): { numeric: number; integer: boolean } | null {
  const representation = canonicalDecimal(value)
  if (!representation) return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  const roundTrip = canonicalDecimal(numeric.toString())
  if (
    !roundTrip ||
    representation.negative !== roundTrip.negative ||
    representation.digits !== roundTrip.digits ||
    representation.exponent !== roundTrip.exponent
  ) {
    return null
  }
  return {
    numeric,
    integer: representation.digits === '0' || representation.exponent >= 0,
  }
}

function normalizeStringScalar(value: string, types: ReadonlySet<string>): unknown {
  // A string branch makes every string representation intentional and therefore ambiguous.
  if (types.has('string')) return value

  const candidate = value.trim()
  if (candidate === 'null' && types.has('null')) return null
  if (types.has('boolean') && (candidate === 'true' || candidate === 'false')) {
    return candidate === 'true'
  }
  if (!types.has('integer') && !types.has('number')) return value
  if (!JSON_NUMBER_PATTERN.test(candidate)) return value

  const exact = exactJsonNumber(candidate)
  if (!exact) return value
  if (types.has('integer')) {
    if (exact.integer && Number.isSafeInteger(exact.numeric)) return exact.numeric
    if (!types.has('number')) return value
  }
  if (types.has('number')) {
    if (exact.integer && !Number.isSafeInteger(exact.numeric)) return value
    return exact.numeric
  }
  return value
}

function decodeContainerString(value: string, types: ReadonlySet<string>): unknown {
  if (types.has('string')) return value
  const expectsArray = types.has('array')
  const expectsObject = types.has('object')
  const candidate = value.trim()
  if (
    (!expectsArray || !candidate.startsWith('[')) &&
    (!expectsObject || !candidate.startsWith('{'))
  ) {
    return value
  }
  try {
    const decoded: unknown = JSON.parse(candidate)
    if ((expectsArray && Array.isArray(decoded)) || (expectsObject && isJsonObject(decoded))) {
      return decoded
    }
  } catch {
    // The final runtime schema reports the original malformed value.
  }
  return value
}

function unionGroups(nodes: readonly JsonObject[]): readonly (readonly unknown[])[] {
  const groups: unknown[][] = []
  for (const node of nodes) {
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const branches = node[keyword]
      if (Array.isArray(branches) && branches.length > 0) groups.push(branches)
    }
  }
  return groups
}

function normalizeUnionGroup(
  source: unknown,
  branches: readonly unknown[],
  context: NormalizationContext,
  depth: number,
): unknown {
  const directlyCompatible = branches.filter((branch) =>
    schemaCouldAccept(source, branch, context.rootSchema, context.maximumDepth, depth + 1),
  )
  const candidates = (directlyCompatible.length > 0 ? directlyCompatible : branches)
    .map((branch) => ({
      branch,
      value: normalizeValue(source, branch, context, depth + 1),
    }))
    .filter(({ branch, value }) =>
      schemaCouldAccept(value, branch, context.rootSchema, context.maximumDepth, depth + 1),
    )

  const first = candidates[0]?.value
  if (first === undefined && candidates.length === 0) return source
  if (candidates.every(({ value }) => sameJsonValue(first, value, context.maximumDepth - depth))) {
    return first
  }
  return source
}

function hasUnconditionalDefaultNull(
  schema: unknown,
  rootSchema: unknown,
  maximumDepth: number,
): boolean {
  const visited = new Set<object>()
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth >= maximumDepth || !isJsonObject(candidate) || visited.has(candidate)) return false
    visited.add(candidate)
    if (Object.hasOwn(candidate, 'default') && candidate.default === null) return true
    if (
      typeof candidate.$ref === 'string' &&
      visit(localSchemaReference(rootSchema, candidate.$ref), depth + 1)
    ) {
      return true
    }
    return (
      Array.isArray(candidate.allOf) && candidate.allOf.some((branch) => visit(branch, depth + 1))
    )
  }
  return visit(schema, 0)
}

function hasExplicitNullMarker(
  schema: unknown,
  rootSchema: unknown,
  maximumDepth: number,
): boolean {
  const visited = new Set<object>()
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth >= maximumDepth || !isJsonObject(candidate) || visited.has(candidate)) return false
    visited.add(candidate)
    if (
      candidate.nullable === true ||
      candidate.type === 'null' ||
      (Array.isArray(candidate.type) && candidate.type.includes('null')) ||
      candidate.const === null ||
      (Array.isArray(candidate.enum) && candidate.enum.includes(null))
    ) {
      return true
    }
    if (
      typeof candidate.$ref === 'string' &&
      visit(localSchemaReference(rootSchema, candidate.$ref), depth + 1)
    ) {
      return true
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = candidate[keyword]
      if (Array.isArray(branches) && branches.some((branch) => visit(branch, depth + 1))) {
        return true
      }
    }
    return false
  }
  return visit(schema, 0)
}

function schemaAcceptsNull(schema: unknown, rootSchema: unknown, maximumDepth: number): boolean {
  const visited = new Set<object>()
  const visit = (candidate: unknown, depth: number): boolean => {
    if (candidate === true) return true
    if (candidate === false || depth >= maximumDepth || !isJsonObject(candidate)) return false
    if (visited.has(candidate)) return false
    visited.add(candidate)
    try {
      const declaredTypes =
        typeof candidate.type === 'string'
          ? [candidate.type]
          : Array.isArray(candidate.type)
            ? candidate.type.filter((entry): entry is string => typeof entry === 'string')
            : []
      if (
        declaredTypes.length > 0 &&
        candidate.nullable !== true &&
        !declaredTypes.includes('null')
      ) {
        return false
      }
      if (Object.hasOwn(candidate, 'const') && candidate.const !== null) return false
      if (Array.isArray(candidate.enum) && !candidate.enum.includes(null)) return false

      if (typeof candidate.$ref === 'string') {
        const referenced = localSchemaReference(rootSchema, candidate.$ref)
        if (referenced === undefined || !visit(referenced, depth + 1)) return false
      }
      if (
        Array.isArray(candidate.allOf) &&
        !candidate.allOf.every((branch) => visit(branch, depth + 1))
      ) {
        return false
      }
      if (
        Array.isArray(candidate.anyOf) &&
        !candidate.anyOf.some((branch) => visit(branch, depth + 1))
      ) {
        return false
      }
      if (Array.isArray(candidate.oneOf)) {
        const acceptingBranches = candidate.oneOf.filter((branch) => visit(branch, depth + 1))
        if (acceptingBranches.length !== 1) return false
      }
      if (candidate.not !== undefined && visit(candidate.not, depth + 1)) return false
      return true
    } finally {
      visited.delete(candidate)
    }
  }
  return visit(schema, 0)
}

function schemasForObjectProperty(nodes: readonly JsonObject[], name: string): unknown[] {
  const schemas: unknown[] = []
  for (const node of nodes) {
    const properties = isJsonObject(node.properties) ? node.properties : undefined
    if (properties && Object.hasOwn(properties, name)) {
      schemas.push(properties[name])
      continue
    }
    if (isJsonObject(node.additionalProperties)) schemas.push(node.additionalProperties)
  }
  return schemas
}

function requiredDefaultNullProperties(
  schema: unknown,
  rootSchema: unknown,
  maximumDepth: number,
): Set<string> {
  const names = new Set<string>()
  const nodes: JsonObject[] = []
  const visited = new Set<object>()
  const visitUnconditional = (candidate: unknown, depth: number): void => {
    if (depth >= maximumDepth || !isJsonObject(candidate) || visited.has(candidate)) return
    visited.add(candidate)
    nodes.push(candidate)
    if (typeof candidate.$ref === 'string') {
      visitUnconditional(localSchemaReference(rootSchema, candidate.$ref), depth + 1)
    }
    const allOf = candidate.allOf
    if (Array.isArray(allOf)) {
      for (const branch of allOf) visitUnconditional(branch, depth + 1)
    }
  }
  visitUnconditional(schema, 0)

  for (const node of nodes) {
    if (!Array.isArray(node.required)) continue
    const properties = isJsonObject(node.properties) ? node.properties : undefined
    for (const name of node.required) {
      if (typeof name !== 'string' || !properties || !Object.hasOwn(properties, name)) continue
      const property = properties[name]
      if (
        hasUnconditionalDefaultNull(property, rootSchema, maximumDepth) &&
        hasExplicitNullMarker(property, rootSchema, maximumDepth) &&
        schemaAcceptsNull(property, rootSchema, maximumDepth)
      ) {
        names.add(name)
      }
    }
  }
  return names
}

function schemasForArrayIndex(nodes: readonly JsonObject[], index: number): unknown[] {
  const schemas: unknown[] = []
  for (const node of nodes) {
    const prefixItems = Array.isArray(node.prefixItems) ? node.prefixItems : undefined
    if (prefixItems && index < prefixItems.length) {
      schemas.push(prefixItems[index])
      continue
    }
    if (isJsonObject(node.items) || typeof node.items === 'boolean') schemas.push(node.items)
  }
  return schemas
}

function ownCopy(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value))
}

function defineOwn(value: JsonObject, name: string, child: unknown): void {
  Object.defineProperty(value, name, {
    value: child,
    configurable: true,
    enumerable: true,
    writable: true,
  })
}

function normalizeValue(
  source: unknown,
  schema: unknown,
  context: NormalizationContext,
  depth: number,
): unknown {
  if (depth >= context.maximumDepth || !isJsonObject(schema)) return source
  const analysis = analyzeSchema(schema, context.rootSchema, context.maximumDepth - depth)
  if (analysis.nodes.length === 0) return source

  let value = source
  for (const branches of unionGroups(analysis.nodes)) {
    value = normalizeUnionGroup(value, branches, context, depth)
  }
  if (typeof value === 'string') {
    const scalar = normalizeStringScalar(value, analysis.types)
    if (scalar !== value) return scalar
    value = decodeContainerString(value, analysis.types)
    if (typeof value === 'string') return source
  }

  if (Array.isArray(value)) {
    if (context.activeValues.has(value)) return value
    context.activeValues.add(value)
    try {
      let normalized: unknown[] | undefined
      for (let index = 0; index < value.length; index += 1) {
        const itemSchema = combinedSchema(schemasForArrayIndex(analysis.nodes, index))
        if (!itemSchema) continue
        const child = normalizeValue(value[index], itemSchema, context, depth + 1)
        if (child === value[index]) continue
        normalized ??= value.slice()
        normalized[index] = child
      }
      return normalized ?? value
    } finally {
      context.activeValues.delete(value)
    }
  }

  if (!isJsonObject(value)) return value
  if (context.activeValues.has(value)) return value
  context.activeValues.add(value)
  try {
    let normalized: JsonObject | undefined
    for (const [name, current] of Object.entries(value)) {
      const propertySchema = combinedSchema(schemasForObjectProperty(analysis.nodes, name))
      if (!propertySchema) continue
      const child = normalizeValue(current, propertySchema, context, depth + 1)
      if (child === current) continue
      normalized ??= ownCopy(value)
      defineOwn(normalized, name, child)
    }

    for (const name of requiredDefaultNullProperties(
      schema,
      context.rootSchema,
      context.maximumDepth - depth,
    )) {
      if (Object.hasOwn(value, name)) continue
      normalized ??= ownCopy(value)
      defineOwn(normalized, name, null)
    }
    return normalized ?? value
  } finally {
    context.activeValues.delete(value)
  }
}

/**
 * Repairs provider serialization drift only when the active JSON Schema makes the conversion
 * unambiguous. The input is never mutated; callers must still validate the result with their
 * runtime schema before executing a tool.
 */
export function normalizeJsonSchemaValue(
  value: unknown,
  schema: unknown,
  maximumDepth = DEFAULT_MAX_NORMALIZATION_DEPTH,
): unknown {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1) return value
  return normalizeValue(
    value,
    schema,
    { rootSchema: schema, maximumDepth, activeValues: new WeakSet<object>() },
    0,
  )
}

/** Preserves the provider's original JSON text when no schema-directed repair is needed. */
export function normalizeJsonSchemaArguments(argumentsJson: string, schema: unknown): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return argumentsJson
  }
  const normalized = normalizeJsonSchemaValue(parsed, schema)
  return normalized === parsed ? argumentsJson : JSON.stringify(normalized)
}
