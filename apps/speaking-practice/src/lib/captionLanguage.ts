export type CaptionLanguage = 'chinese' | 'non_chinese';

const HAN_PATTERN = /[\u3400-\u9fff]/g;
const JAPANESE_PATTERN = /[\u3040-\u30ff]/;
const KOREAN_PATTERN = /[\uac00-\ud7af]/;
const LATIN_PATTERN = /[A-Za-z]/g;

export function detectCaptionLanguage(texts: readonly string[]): CaptionLanguage {
  const text = texts.join('');
  const hanCount = text.match(HAN_PATTERN)?.length ?? 0;
  const latinCount = text.match(LATIN_PATTERN)?.length ?? 0;

  // Kana or Hangul gives us a useful signal that the Han characters belong to another language.
  if (JAPANESE_PATTERN.test(text) || KOREAN_PATTERN.test(text)) return 'non_chinese';
  if (hanCount === 0) return 'non_chinese';

  // A stray Chinese character in an otherwise Latin subtitle should not hide translation.
  return hanCount >= Math.max(2, Math.ceil(latinCount * 0.1)) ? 'chinese' : 'non_chinese';
}

export function shouldOfferChineseTranslation(texts: readonly string[]): boolean {
  return detectCaptionLanguage(texts) === 'non_chinese';
}
