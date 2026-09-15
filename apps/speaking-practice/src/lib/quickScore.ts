export type QuickAudioFeatures = {
  durationSeconds: number;
  voicedRatio: number;
  pitchRatio: number;
  pauseCount: number;
  pauseSegments: Array<{ startSeconds: number; endSeconds: number }>;
  pitchContour: number[];
  energyContour: number[];
  clippingRatio: number;
  hasPitch: boolean;
};

export type QuickScoreDiagnostic = {
  reference: QuickAudioFeatures;
  recording: QuickAudioFeatures;
};

export type QuickScoreResult = {
  score: number;
  confidence: 'high' | 'medium' | 'low';
  confidenceLabel: string;
  subscores: {
    prosody: number;
    rhythm: number;
  };
  metrics: {
    referenceDuration: number;
    recordingDuration: number;
    durationRatio: number;
    pitchSimilarity: number;
    energySimilarity: number;
  };
  quality: {
    level: 'good' | 'warning' | 'poor';
    label: string;
    warnings: string[];
    speechRatio: number;
    pitchRatio: number;
    clippingRatio: number;
  };
  visuals: {
    referencePitchContour: number[];
    recordingPitchContour: number[];
    referenceEnergyContour: number[];
    recordingEnergyContour: number[];
    referencePauseSegments: Array<{ startSeconds: number; endSeconds: number }>;
    recordingPauseSegments: Array<{ startSeconds: number; endSeconds: number }>;
  };
  diagnostic: QuickScoreDiagnostic;
  notes: string[];
};

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 512;
const HOP_SIZE = 256;
const MIN_PITCH_HZ = 70;
const MAX_PITCH_HZ = 500;
const SERIES_LENGTH = 64;

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!samples.length || fromRate === toRate) return samples;
  const length = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const result = new Float32Array(length);
  const scale = (samples.length - 1) / Math.max(1, length - 1);
  for (let index = 0; index < length; index += 1) {
    const position = index * scale;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    result[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return result;
}

function findActiveBounds(samples: Float32Array, sampleRate: number): { start: number; end: number } {
  if (!samples.length) return { start: 0, end: 0 };
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak < 0.002) return { start: 0, end: samples.length };

  const frameLength = Math.max(1, Math.round(sampleRate * 0.02));
  const threshold = Math.max(0.008, peak * 0.08);
  const frameCount = Math.ceil(samples.length / frameLength);
  const rmsValues: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameLength;
    const end = Math.min(samples.length, start + frameLength);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += samples[index] ** 2;
    rmsValues.push(Math.sqrt(energy / Math.max(1, end - start)));
  }
  const firstActiveFrame = rmsValues.findIndex((rms) => rms >= threshold);
  let firstFrame = firstActiveFrame < 0 ? 0 : firstActiveFrame;
  let lastFrame = frameCount - 1;

  // Microphones often emit a short startup burst when getUserMedia opens the
  // device. If it is followed by a real gap, do not score that burst as the
  // beginning of the learner's sentence.
  if (firstActiveFrame >= 0) {
    let initialRunEnd = firstActiveFrame;
    while (initialRunEnd < frameCount && rmsValues[initialRunEnd] >= threshold) initialRunEnd += 1;
    const stableThreshold = Math.max(0.008, threshold * 0.65);
    let transientEnd = initialRunEnd;
    while (transientEnd < frameCount && rmsValues[transientEnd] >= stableThreshold) transientEnd += 1;
    let stableSpeechStart = transientEnd;
    while (stableSpeechStart < frameCount && rmsValues[stableSpeechStart] < stableThreshold) stableSpeechStart += 1;
    const initialRunFrames = transientEnd - firstActiveFrame;
    const leadingGapFrames = stableSpeechStart - transientEnd;
    const stableWindowFrames = Math.max(5, Math.ceil(0.12 / 0.02));
    const stableActiveFrames = Math.max(4, Math.ceil(stableWindowFrames * 0.6));
    if (firstActiveFrame <= 1 && initialRunFrames <= Math.ceil(0.18 / 0.02) && leadingGapFrames >= Math.ceil(0.18 / 0.02)) {
      for (let frame = stableSpeechStart; frame < frameCount; frame += 1) {
        const windowEnd = Math.min(frameCount, frame + stableWindowFrames);
        const activeFrames = rmsValues.slice(frame, windowEnd).filter((rms) => rms >= stableThreshold).length;
        if (activeFrames >= stableActiveFrames) {
          firstFrame = frame;
          break;
        }
      }
    }
  }
  for (let frame = frameCount - 1; frame >= 0; frame -= 1) {
    if (rmsValues[frame] >= threshold) {
      lastFrame = frame;
      break;
    }
  }
  const start = Math.max(0, firstFrame * frameLength - Math.round(sampleRate * 0.04));
  const end = Math.min(samples.length, (lastFrame + 1) * frameLength + Math.round(sampleRate * 0.04));
  return { start, end: Math.max(start + 1, end) };
}

function frameRms(frame: Float32Array, start: number, end: number): number {
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += frame[index] ** 2;
  return Math.sqrt(energy / Math.max(1, end - start));
}

function estimatePitch(frame: Float32Array, sampleRate: number): number {
  let frameMean = 0;
  for (const sample of frame) frameMean += sample;
  frameMean /= Math.max(1, frame.length);

  let energy = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const centered = frame[index] - frameMean;
    energy += centered * centered;
  }
  if (Math.sqrt(energy / Math.max(1, frame.length)) < 0.012) return 0;

  const minLag = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ));
  const maxLag = Math.min(frame.length - 2, Math.ceil(sampleRate / MIN_PITCH_HZ));
  let bestLag = 0;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let cross = 0;
    let firstEnergy = 0;
    let secondEnergy = 0;
    for (let index = 0; index < frame.length - lag; index += 1) {
      const first = frame[index] - frameMean;
      const second = frame[index + lag] - frameMean;
      cross += first * second;
      firstEnergy += first * first;
      secondEnergy += second * second;
    }
    const denominator = Math.sqrt(firstEnergy * secondEnergy);
    const correlation = denominator > 0 ? cross / denominator : 0;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  return bestLag && bestCorrelation >= 0.35 ? sampleRate / bestLag : 0;
}

function normalizeContour(values: number[], { logScale = false } = {}): number[] {
  const valid = values.filter((value) => value > 0 && Number.isFinite(value));
  if (!valid.length) return values.map(() => 0);
  const center = logScale ? Math.log2(median(valid)) : median(valid);
  return values.map((value) => {
    if (!value || !Number.isFinite(value)) return 0;
    if (logScale) return clamp(12 * (Math.log2(value) - center), -24, 24);
    return (value - center) / Math.max(center, 1e-6);
  });
}

function fillGaps(values: number[]): number[] {
  const result = [...values];
  let previous = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== 0) {
      previous = result[index];
      continue;
    }
    let nextIndex = index + 1;
    while (nextIndex < result.length && result[nextIndex] === 0) nextIndex += 1;
    const next = nextIndex < result.length ? result[nextIndex] : previous;
    result[index] = previous || next || 0;
  }
  return result;
}

function resampleSeries(values: number[], length = SERIES_LENGTH): number[] {
  if (!values.length) return Array.from({ length }, () => 0);
  if (values.length === length) return [...values];
  const result: number[] = [];
  const scale = (values.length - 1) / Math.max(1, length - 1);
  for (let index = 0; index < length; index += 1) {
    const position = index * scale;
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const fraction = position - left;
    result.push(values[left] * (1 - fraction) + values[right] * fraction);
  }
  return result;
}

function contourSimilarity(left: number[], right: number[]): number {
  const a = resampleSeries(left);
  const b = resampleSeries(right);
  const aCenter = mean(a);
  const bCenter = mean(b);
  const aScale = Math.max(Math.sqrt(mean(a.map((value) => (value - aCenter) ** 2))), 1);
  const bScale = Math.max(Math.sqrt(mean(b.map((value) => (value - bCenter) ** 2))), 1);
  const columns = b.length + 1;
  const costs = new Float64Array((a.length + 1) * columns);
  costs.fill(Number.POSITIVE_INFINITY);
  costs[0] = 0;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const leftValue = (a[row - 1] - aCenter) / aScale;
      const rightValue = (b[column - 1] - bCenter) / bScale;
      const previous = Math.min(
        costs[(row - 1) * columns + column],
        costs[row * columns + column - 1],
        costs[(row - 1) * columns + column - 1],
      );
      costs[row * columns + column] = Math.abs(leftValue - rightValue) + previous;
    }
  }
  const distance = costs[a.length * columns + b.length] / Math.max(1, a.length + b.length);
  return clamp(100 * Math.exp(-distance / 0.92));
}

function durationScore(referenceSeconds: number, recordingSeconds: number): number {
  if (referenceSeconds <= 0 || recordingSeconds <= 0) return 0;
  const ratio = recordingSeconds / referenceSeconds;
  return clamp(100 * Math.exp(-Math.abs(Math.log(ratio)) / 0.32));
}

function confidenceFor(reference: QuickAudioFeatures, recording: QuickAudioFeatures): QuickScoreResult['confidence'] {
  const weakestVoicedRatio = Math.min(reference.voicedRatio, recording.voicedRatio);
  const weakestPitchRatio = Math.min(reference.pitchRatio, recording.pitchRatio);
  if (weakestVoicedRatio >= 0.48 && weakestPitchRatio >= 0.18 && reference.hasPitch && recording.hasPitch) return 'high';
  if (weakestVoicedRatio >= 0.22 && weakestPitchRatio >= 0.08) return 'medium';
  return 'low';
}

function qualityFor(recording: QuickAudioFeatures): QuickScoreResult['quality'] {
  const warnings: string[] = [];
  if (recording.durationSeconds < 0.65) warnings.push('录音太短，暂时只能作为参考');
  if (recording.voicedRatio < 0.28) warnings.push('有效人声偏少，请靠近麦克风并完整说完这一句');
  else if (recording.voicedRatio < 0.48) warnings.push('有效人声偏少，评分稳定性一般');
  if (recording.pitchRatio < 0.08) warnings.push('可识别的音高较少，语气评分会降低可信度');
  if (recording.clippingRatio > 0.002) warnings.push('录音有爆音，建议降低麦克风音量后重录');
  const level = warnings.length >= 2 || recording.clippingRatio > 0.01 ? 'poor' : warnings.length ? 'warning' : 'good';
  return {
    level,
    label: level === 'good' ? '录音质量良好' : level === 'warning' ? '录音质量一般' : '建议重新录音',
    warnings,
    speechRatio: recording.voicedRatio,
    pitchRatio: recording.pitchRatio,
    clippingRatio: recording.clippingRatio,
  };
}

export function analyzePcm(samples: Float32Array, sampleRate: number): QuickAudioFeatures {
  const resampled = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  const bounds = findActiveBounds(resampled, TARGET_SAMPLE_RATE);
  const active = resampled.slice(bounds.start, bounds.end);
  const frameCount = Math.max(1, Math.ceil(Math.max(1, active.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const rmsValues: number[] = [];
  const pitchValues: number[] = [];
  let voicedFrames = 0;
  const pauseSegments: Array<{ startSeconds: number; endSeconds: number }> = [];
  let pauseStartFrame: number | null = null;
  let wasPaused = false;
  let clippingSamples = 0;
  for (const sample of active) if (Math.abs(sample) >= 0.985) clippingSamples += 1;

  const closePause = (endFrame: number) => {
    if (pauseStartFrame === null) return;
    const startSeconds = pauseStartFrame * HOP_SIZE / TARGET_SAMPLE_RATE;
    const endSeconds = endFrame * HOP_SIZE / TARGET_SAMPLE_RATE;
    if (endSeconds - startSeconds >= 0.08) pauseSegments.push({ startSeconds, endSeconds });
    pauseStartFrame = null;
  };

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * HOP_SIZE;
    const frame = new Float32Array(FRAME_SIZE);
    const available = Math.min(FRAME_SIZE, Math.max(0, active.length - start));
    if (available > 0) frame.set(active.subarray(start, start + available));
    const rms = frameRms(frame, 0, Math.max(available, 1));
    const isPaused = rms < 0.012;
    rmsValues.push(rms);
    pitchValues.push(isPaused ? 0 : estimatePitch(frame, TARGET_SAMPLE_RATE));
    if (!isPaused) voicedFrames += 1;
    if (isPaused && !wasPaused) pauseStartFrame = frameIndex;
    if (!isPaused && wasPaused) closePause(frameIndex);
    wasPaused = isPaused;
  }
  if (wasPaused) closePause(frameCount);

  const energyCenter = Math.max(median(rmsValues), 1e-5);
  const energyContour = rmsValues.map((value) => Math.log(Math.max(value, 1e-5) / energyCenter));
  const voicedPitchValues = pitchValues.filter((value) => value > 0);
  const pitchContour = normalizeContour(fillGaps(pitchValues), { logScale: true });
  return {
    durationSeconds: active.length / TARGET_SAMPLE_RATE,
    voicedRatio: voicedFrames / Math.max(1, frameCount),
    pitchRatio: voicedPitchValues.length / Math.max(1, frameCount),
    pauseCount: pauseSegments.length,
    pauseSegments,
    pitchContour,
    energyContour,
    clippingRatio: clippingSamples / Math.max(1, active.length),
    hasPitch: voicedPitchValues.length >= 3,
  };
}

export function calculateQuickScore(reference: QuickAudioFeatures, recording: QuickAudioFeatures): QuickScoreResult {
  const pitchSimilarity = reference.hasPitch && recording.hasPitch
    ? contourSimilarity(reference.pitchContour, recording.pitchContour)
    : 50;
  const energySimilarity = contourSimilarity(reference.energyContour, recording.energyContour);
  const rhythm = durationScore(reference.durationSeconds, recording.durationSeconds);
  const prosody = clamp(pitchSimilarity * 0.7 + energySimilarity * 0.3);
  const quality = qualityFor(recording);
  const qualityPenalty = clamp(recording.clippingRatio * 8000 + (quality.level === 'poor' ? 8 : quality.level === 'warning' ? 2 : 0));
  const score = Math.round(clamp(prosody * 0.65 + rhythm * 0.35 - qualityPenalty));
  const confidence = confidenceFor(reference, recording);
  const durationRatio = reference.durationSeconds > 0 ? recording.durationSeconds / reference.durationSeconds : 1;
  const notes: string[] = [...quality.warnings];

  if (durationRatio > 1.15) notes.push(`你的语速比范例慢约 ${Math.max(0, recording.durationSeconds - reference.durationSeconds).toFixed(1)} 秒`);
  else if (durationRatio < 0.85) notes.push(`你的语速比范例快约 ${Math.max(0, reference.durationSeconds - recording.durationSeconds).toFixed(1)} 秒`);
  else notes.push('整体语速和范例接近');
  if (pitchSimilarity < 65) notes.push('音高变化和范例差异较大，可以注意句中的升降调');
  if (confidence === 'low' && !quality.warnings.some((note) => note.includes('参考'))) notes.push('当前可用声音特征较少，结果只适合作为参考');

  return {
    score,
    confidence,
    confidenceLabel: confidence === 'high' ? '参考度高' : confidence === 'medium' ? '参考度中等' : '参考度较低',
    subscores: {
      prosody: Math.round(prosody),
      rhythm: Math.round(rhythm),
    },
    metrics: {
      referenceDuration: reference.durationSeconds,
      recordingDuration: recording.durationSeconds,
      durationRatio,
      pitchSimilarity: Math.round(pitchSimilarity),
      energySimilarity: Math.round(energySimilarity),
    },
    quality,
    visuals: {
      referencePitchContour: resampleSeries(reference.pitchContour),
      recordingPitchContour: resampleSeries(recording.pitchContour),
      referenceEnergyContour: resampleSeries(reference.energyContour),
      recordingEnergyContour: resampleSeries(recording.energyContour),
      referencePauseSegments: reference.pauseSegments,
      recordingPauseSegments: recording.pauseSegments,
    },
    diagnostic: {
      reference,
      recording,
    },
    notes,
  };
}

function getAudioContext(): AudioContext {
  if (typeof window === 'undefined' || !window.AudioContext) throw new Error('当前浏览器不支持本地音频评分');
  return new window.AudioContext();
}

async function decodeAudioData(blob: Blob): Promise<AudioBuffer> {
  const context = getAudioContext();
  try {
    const data = await blob.arrayBuffer();
    return await context.decodeAudioData(data.slice(0));
  } finally {
    await context.close().catch(() => undefined);
  }
}

function audioBufferToMono(buffer: AudioBuffer, startSeconds = 0, endSeconds = buffer.duration): Float32Array {
  const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
  const end = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));
  const length = Math.max(1, end - start);
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel).subarray(start, end);
    for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / buffer.numberOfChannels;
  }
  return mono;
}

export async function analyzeAudioBlob(blob: Blob, startSeconds = 0, endSeconds?: number): Promise<QuickAudioFeatures> {
  const buffer = await decodeAudioData(blob);
  return analyzePcm(audioBufferToMono(buffer, startSeconds, endSeconds ?? buffer.duration), buffer.sampleRate);
}

export async function analyzeAudioUrl(url: string, startSeconds = 0, endSeconds?: number): Promise<QuickAudioFeatures> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('范例音频暂时无法读取');
  return analyzeAudioBlob(await response.blob(), startSeconds, endSeconds);
}
