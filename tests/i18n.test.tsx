import { describe, expect, it } from 'vitest'
import {
  APP_LOCALE_HINT_KEY,
  createI18n,
  persistAppLocaleHint,
  readInitialAppLocale,
  resolveInitialAppLocale,
} from '../src/renderer/src/i18n'

describe('renderer i18n', () => {
  it('resolves the same typed keys in Korean and English', () => {
    expect(createI18n('ko').t('goals.status.active')).toBe('진행 중')
    expect(createI18n('en').t('goals.status.active')).toBe('Active')
    expect(createI18n('ko').t('slash.empty.title')).toBe('일치하는 명령이 없어요')
    expect(createI18n('en').t('slash.empty.title')).toBe('No matching commands')
    expect(createI18n('ko').t('tool.status.recovered')).toBe('재시도로 복구됨')
    expect(createI18n('en').t('tool.status.recovered')).toBe('Recovered by retry')
    expect(createI18n('ko').t('tool.count.filesApplied', { count: 2, formattedCount: '2' })).toBe(
      '파일 2개 적용',
    )
    expect(createI18n('en').t('tool.count.filesApplied', { count: 2, formattedCount: '2' })).toBe(
      '2 files applied',
    )
    expect(createI18n('ko').t('readiness.action.trustWorkspace')).toBe('Trust 검토')
    expect(createI18n('en').t('readiness.action.trustWorkspace')).toBe('Review Trust')
    expect(createI18n('ko').t('conversation.empty.title')).toBe('오늘은 무엇을 만들어볼까요?')
    expect(createI18n('en').t('conversation.empty.title')).toBe(
      'What would you like to build today?',
    )
    expect(createI18n('ko').t('readiness.progress', { completed: 3, remaining: 1 })).toBe(
      '설정 3개 완료 · 1개 남음',
    )
    expect(createI18n('ko').t('readiness.action.startConversation')).toBe('요청 입력하기')
    expect(createI18n('ko').t('conversation.copyAnswer')).toBe('답변 복사')
    expect(createI18n('en').t('conversation.answerCopied')).toBe('Copied')
  })

  it('formats numbers and timestamps with the selected app locale', () => {
    const korean = createI18n('ko')
    const english = createI18n('en')
    const timestamp = Date.UTC(2026, 6, 13, 4, 5)
    const dateOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }

    expect(korean.localeTag).toBe('ko-KR')
    expect(english.localeTag).toBe('en-US')
    expect(korean.formatDateTime(timestamp, dateOptions)).toContain('7월')
    expect(english.formatDateTime(timestamp, dateOptions)).toContain('July')
    expect(korean.formatNumber(12_000, { notation: 'compact' })).not.toBe(
      english.formatNumber(12_000, { notation: 'compact' }),
    )
  })

  it('uses only a valid non-sensitive locale hint before authoritative settings load', () => {
    expect(resolveInitialAppLocale('en')).toBe('en')
    expect(resolveInitialAppLocale('ko')).toBe('ko')
    expect(resolveInitialAppLocale('fr')).toBe('ko')
    expect(resolveInitialAppLocale(null)).toBe('ko')

    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    persistAppLocaleHint('en', storage)
    expect(values.get(APP_LOCALE_HINT_KEY)).toBe('en')
    expect(readInitialAppLocale(storage)).toBe('en')
  })

  it('falls back safely when hardened storage getters reject access', () => {
    const inaccessibleStorage = Object.defineProperties(
      {},
      {
        getItem: {
          get: () => {
            throw new DOMException('Storage is disabled', 'SecurityError')
          },
        },
        setItem: {
          get: () => {
            throw new DOMException('Storage is disabled', 'SecurityError')
          },
        },
      },
    )

    expect(readInitialAppLocale(inaccessibleStorage)).toBe('ko')
    expect(() => persistAppLocaleHint('en', inaccessibleStorage)).not.toThrow()
  })
})
