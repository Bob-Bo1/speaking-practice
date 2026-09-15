export type WordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type ChartWord = WordTiming & {
  startRatio: number;
  endRatio: number;
};

const cleanWord = (value: unknown): string => String(value ?? '')
  .replace(/▁/g, '')
  .trim()
  .replace(/^[,.;!?，。！？、；：:]+|[,.;!?，。！？、；：:]+$/g, '');

const asSeconds = (value: unknown, scale: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number * scale : NaN;
};

const normalizeTimings = (entries: WordTiming[]): WordTiming[] => entries
  .filter((entry) => entry.text && Number.isFinite(entry.startSeconds) && Number.isFinite(entry.endSeconds) && entry.endSeconds > entry.startSeconds)
  .sort((left, right) => left.startSeconds - right.startSeconds);

function parseWhisperSegments(payload: Record<string, unknown>): WordTiming[] {
  const entries: WordTiming[] = [];
  for (const segment of Array.isArray(payload.segments) ? payload.segments : []) {
    if (!segment || typeof segment !== 'object') continue;
    const words = (segment as Record<string, unknown>).words;
    if (!Array.isArray(words)) continue;
    for (const word of words) {
      if (!word || typeof word !== 'object') continue;
      const item = word as Record<string, unknown>;
      entries.push({
        text: cleanWord(item.word),
        startSeconds: asSeconds(item.start, 1),
        endSeconds: asSeconds(item.end, 1),
      });
    }
  }
  return normalizeTimings(entries);
}

function parseFunASRWords(payload: Record<string, unknown>): WordTiming[] {
  const words = Array.isArray(payload.words) ? payload.words : [];
  const timestamps = Array.isArray(payload.timestamp) ? payload.timestamp : [];
  if (!words.length || words.length !== timestamps.length) return [];

  const entries: WordTiming[] = [];
  let current: WordTiming | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const token = String(words[index] ?? '');
    const visible = cleanWord(token);
    const timestamp = timestamps[index];
    if (!visible || !Array.isArray(timestamp) || timestamp.length < 2) continue;
    const startSeconds = asSeconds(timestamp[0], 0.001);
    const endSeconds = asSeconds(timestamp[1], 0.001);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) continue;

    const startsNewWord = token.includes('▁') || /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(visible) || !current;
    if (startsNewWord) {
      if (current) entries.push(current);
      current = { text: visible, startSeconds, endSeconds };
    } else if (current) {
      current.text += visible;
      current.endSeconds = endSeconds;
    }
  }
  if (current) entries.push(current);
  return normalizeTimings(entries);
}

export function parseWordTimings(payload: unknown): WordTiming[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  return parseWhisperSegments(record).concat(parseFunASRWords(record)).sort((left, right) => left.startSeconds - right.startSeconds);
}

export function transcriptionUrlForAudio(audioUrl: string): string | null {
  const slash = audioUrl.lastIndexOf('/');
  return slash >= 0 ? `${audioUrl.slice(0, slash)}/transcription.json` : null;
}

function splitCueLabels(text: string): string[] {
  const tokens = text.match(/[A-Za-z]+(?:['’.-][A-Za-z]+)*|\d+(?:[.,]\d+)?|[\u3400-\u9fff]|[\u3040-\u30ff]|[\uac00-\ud7af]/g) ?? [];
  if (tokens.length) return tokens;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length ? words : ['整句'];
}

function equalChartWords(text: string): ChartWord[] {
  const labels = splitCueLabels(text);
  return labels.map((label, index) => ({
    text: label,
    startSeconds: 0,
    endSeconds: 0,
    startRatio: index / labels.length,
    endRatio: (index + 1) / labels.length,
  }));
}

export function chartWordsForCue(text: string, cueStart: number, cueEnd: number, timings: WordTiming[]): ChartWord[] {
  const fallback = equalChartWords(text);
  const words = timings.filter((word) => word.endSeconds > cueStart && word.startSeconds < cueEnd);
  if (!words.length) return fallback;

  const first = words[0].startSeconds;
  const last = words[words.length - 1].endSeconds;
  const duration = Math.max(last - first, 0.001);
  const expectedLabels = splitCueLabels(text);
  return words.map((word, index) => ({
    ...word,
    text: expectedLabels.length === words.length ? expectedLabels[index] : word.text,
    startRatio: Math.max(0, Math.min(1, (word.startSeconds - first) / duration)),
    endRatio: Math.max(0, Math.min(1, (word.endSeconds - first) / duration)),
  }));
}
