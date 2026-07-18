import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SLASH_COMMANDS,
  type BuiltinCommandArgumentError,
  findBuiltinSlashCommand,
  localizeBuiltinSlashCommands,
  parseSingleCommandArgument,
} from '../src/shared/builtin-commands'

describe('built-in slash command registry', () => {
  it('has stable, unique command names and ids', () => {
    const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name)
    const ids = BUILTIN_SLASH_COMMANDS.map((command) => command.id)

    expect(new Set(names).size).toBe(names.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(names.every((name) => /^[a-z][a-z0-9-]*$/.test(name))).toBe(true)
  })

  it('looks commands up without depending on input casing', () => {
    expect(findBuiltinSlashCommand(' Review ')?.name).toBe('review')
    expect(findBuiltinSlashCommand('missing')).toBeUndefined()
  })

  it('keeps workflow arguments clearly delimited in generated prompts', () => {
    const review = findBuiltinSlashCommand('review')
    expect(review?.kind).toBe('prompt')
    if (review?.kind !== 'prompt') return

    const prompt = review.buildPrompt('src/main and "quoted" files')
    expect(prompt).toContain('workspace tools')
    expect(prompt).toContain('"src/main and \\"quoted\\" files"')
  })

  it('assigns explicit non-mutating intents to built-in prompt workflows', () => {
    const promptIntents = Object.fromEntries(
      BUILTIN_SLASH_COMMANDS.filter((command) => command.kind === 'prompt').map((command) => [
        command.name,
        command.intent,
      ]),
    )

    expect(promptIntents).toEqual({
      review: 'answer',
      explain: 'answer',
      plan: 'plan',
      tests: 'answer',
    })
  })

  it('localizes renderer metadata without changing command identity or workflow prompts', () => {
    const korean = localizeBuiltinSlashCommands('ko')
    const english = localizeBuiltinSlashCommands('en')

    expect(english.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual(
      korean.map(({ id, name, kind }) => ({ id, name, kind })),
    )
    expect(english.find((command) => command.name === 'settings')).toMatchObject({
      description: 'Open provider, model, theme, and app settings.',
      category: 'App',
    })
    expect(english.find((command) => command.name === 'settings')?.keywords).toEqual(
      expect.arrayContaining(['설정', 'settings']),
    )

    const koreanReview = korean.find((command) => command.name === 'review')
    const englishReview = english.find((command) => command.name === 'review')
    expect(koreanReview?.kind).toBe('prompt')
    expect(englishReview?.kind).toBe('prompt')
    if (koreanReview?.kind !== 'prompt' || englishReview?.kind !== 'prompt') return
    expect(englishReview.buildPrompt('src/main')).toBe(koreanReview.buildPrompt('src/main'))
  })

  it('parses local arguments without splitting paths that contain spaces', () => {
    expect(parseSingleCommandArgument('  src/a b.ts  ')).toBe('src/a b.ts')
    expect(parseSingleCommandArgument('"src/a b.ts"')).toBe('src/a b.ts')
    expect(parseSingleCommandArgument("'model id'")).toBe('model id')
    expect(() => parseSingleCommandArgument('"unterminated')).toThrow('닫히지 않았습니다')
    expect(() => parseSingleCommandArgument('"bad\\escape"')).toThrow('이스케이프')
  })

  it('returns stable argument error codes with locale-specific public messages', () => {
    let failure: BuiltinCommandArgumentError | undefined
    try {
      parseSingleCommandArgument('"unterminated', 'en')
    } catch (cause) {
      failure = cause as BuiltinCommandArgumentError
    }
    expect(failure).toMatchObject({
      code: 'DOUBLE_QUOTE_UNTERMINATED',
      message: 'The double quote in the command argument is not closed.',
    })
  })
})
