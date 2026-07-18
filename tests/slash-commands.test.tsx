import { describe, expect, it } from 'vitest'
import {
  applySlashCommandSelection,
  nextEnabledSlashCommandIndex,
  parseSlashInvocation,
  type RuntimeSlashCommand,
  rankSlashCommands,
  resolveSlashCommandKeyAction,
} from '../src/renderer/src/slash-commands'

const commands: RuntimeSlashCommand[] = [
  {
    id: 'app:settings',
    name: 'settings',
    description: '공급자 설정을 엽니다.',
    source: 'app',
    keywords: ['provider'],
  },
  {
    id: 'workflow:review',
    name: 'review',
    description: '코드를 검토합니다.',
    argumentHint: '[focus]',
    source: 'workflow',
    keywords: ['security'],
  },
  {
    id: 'workspace:explain',
    name: 'prompts:explain',
    description: '설명 프롬프트',
    argumentHint: null,
    source: 'workspace',
    path: 'commands/explain.command.md',
  },
]

describe('slash command parsing and selection', () => {
  it('only recognizes a slash in the first non-whitespace token by default', () => {
    expect(parseSlashInvocation('  /review src/main')).toMatchObject({
      start: 2,
      query: 'review',
      argumentText: 'src/main',
      hasArgumentSeparator: true,
    })
    expect(parseSlashInvocation('please /review')).toBeNull()
    expect(parseSlashInvocation('https://example.com')).toBeNull()
    expect(parseSlashInvocation('please /review', undefined, { allowInline: true })).toMatchObject({
      query: 'review',
    })
  })

  it('replaces only the command token and preserves existing arguments and suffixes', () => {
    const value = '/rev src/main'
    const invocation = parseSlashInvocation(value)
    expect(invocation).not.toBeNull()
    if (!invocation) return

    expect(applySlashCommandSelection(value, invocation, commands[1])).toEqual({
      value: '/review src/main',
      cursor: '/review'.length,
    })
  })
})

describe('slash command ranking and keyboard behavior', () => {
  it('ranks exact names before metadata-only fuzzy matches', () => {
    expect(rankSlashCommands(commands, 'review').map(({ command }) => command.name)).toEqual([
      'review',
    ])
    expect(rankSlashCommands(commands, 'provider')[0]?.command.name).toBe('settings')
    expect(rankSlashCommands(commands, 'explain')[0]?.command.name).toBe('prompts:explain')
  })

  it('wraps navigation and skips disabled commands', () => {
    expect(
      nextEnabledSlashCommandIndex(
        [{ disabled: false }, { disabled: true }, { disabled: false }],
        0,
        -1,
      ),
    ).toBe(2)
    expect(
      nextEnabledSlashCommandIndex(
        [{ disabled: false }, { disabled: true }, { disabled: false }],
        0,
        1,
      ),
    ).toBe(2)
  })

  it('ignores selection keys while an IME composition is active', () => {
    expect(
      resolveSlashCommandKeyAction({
        key: 'Enter',
        open: true,
        itemCount: 3,
        activeIndex: 0,
        composing: true,
      }),
    ).toBeNull()
    expect(
      resolveSlashCommandKeyAction({
        key: 'Tab',
        open: true,
        itemCount: 3,
        activeIndex: 0,
      }),
    ).toBe('select')
    expect(
      resolveSlashCommandKeyAction({
        key: 'Escape',
        open: true,
        itemCount: 3,
        activeIndex: 0,
      }),
    ).toBe('dismiss')
  })
})
