export type SentencePhase =
  | 'idle'
  | 'preparing_permission'
  | 'playing_example'
  | 'transitioning'
  | 'recording_user'
  | 'processing_recording'
  | 'ready_to_compare'
  | 'playing_a'
  | 'playing_b'
  | 'error';

export type SentenceError = 'permission' | 'unsupported' | 'too_short' | 'invalid_cue' | 'recording';

export type SentenceState = {
  phase: SentencePhase;
  error: SentenceError | null;
};

export type SentenceAction =
  | { type: 'RESET' }
  | { type: 'PREPARE' }
  | { type: 'PLAY_EXAMPLE' }
  | { type: 'TRANSITION' }
  | { type: 'START_RECORDING' }
  | { type: 'START_DIRECT_RECORDING' }
  | { type: 'PROCESS_RECORDING' }
  | { type: 'RECORDING_READY' }
  | { type: 'PLAY_A' }
  | { type: 'PLAY_B' }
  | { type: 'PLAYBACK_READY' }
  | { type: 'FAIL'; error: SentenceError };

export const initialSentenceState: SentenceState = { phase: 'idle', error: null };

const transitions: Record<Exclude<SentenceAction['type'], 'RESET' | 'FAIL'>, SentencePhase[]> = {
  PREPARE: ['idle', 'ready_to_compare', 'error'],
  PLAY_EXAMPLE: ['preparing_permission'],
  TRANSITION: ['playing_example'],
  START_RECORDING: ['transitioning'],
  START_DIRECT_RECORDING: ['preparing_permission'],
  PROCESS_RECORDING: ['recording_user'],
  RECORDING_READY: ['processing_recording'],
  PLAY_A: ['idle', 'ready_to_compare', 'playing_a', 'playing_b'],
  PLAY_B: ['playing_a', 'ready_to_compare', 'playing_b'],
  PLAYBACK_READY: ['playing_a', 'playing_b'],
};

const nextPhase: Record<Exclude<SentenceAction['type'], 'RESET' | 'FAIL'>, SentencePhase> = {
  PREPARE: 'preparing_permission',
  PLAY_EXAMPLE: 'playing_example',
  TRANSITION: 'transitioning',
  START_RECORDING: 'recording_user',
  START_DIRECT_RECORDING: 'recording_user',
  PROCESS_RECORDING: 'processing_recording',
  RECORDING_READY: 'ready_to_compare',
  PLAY_A: 'playing_a',
  PLAY_B: 'playing_b',
  PLAYBACK_READY: 'ready_to_compare',
};

export function sentenceReducer(state: SentenceState, action: SentenceAction): SentenceState {
  if (action.type === 'RESET') return initialSentenceState;
  if (action.type === 'FAIL') return { phase: 'error', error: action.error };
  if (!transitions[action.type].includes(state.phase)) return state;
  return { phase: nextPhase[action.type], error: null };
}

export type TimedCue = { start: number; end: number };

export function hasCueReachedEnd(currentTime: number, cueEnd: number): boolean {
  return Number.isFinite(currentTime) && Number.isFinite(cueEnd) && currentTime >= cueEnd;
}

export function getCueIndexAtTime(cues: TimedCue[], currentTime: number): number {
  const index = cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end);
  return index >= 0 ? index : 0;
}

export function isValidCue(cue: TimedCue | undefined): cue is TimedCue {
  return Boolean(cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start);
}

export function getRecordingLimitSeconds(cue: TimedCue): number {
  const duration = cue.end - cue.start;
  return Math.max(duration * 2, duration + 5);
}

export function formatDurationDifference(exampleSeconds: number, userSeconds: number): string {
  const difference = userSeconds - exampleSeconds;
  if (Math.abs(difference) < 0.1) return '时长接近';
  return `${difference > 0 ? '慢' : '快'} ${Math.abs(difference).toFixed(1)} 秒`;
}
