import {
  ArrowCounterClockwise, Camera, Check, CaretLeft, CaretRight, CircleNotch, Clock,
  FileArrowUp, Gear, LinkSimple, Microphone, Pause, Play, Plus, Record, Stop,
  TextAlignLeft, Trash, Translate, UploadSimple, VideoCamera, X,
} from '@phosphor-icons/react';
import { useEffect, useReducer, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import {
  getRecordingLimitSeconds, hasCueReachedEnd,
  initialSentenceState, isValidCue, sentenceReducer,
  type SentenceError,
} from '../lib/sentenceTraining';
import { shouldOfferChineseTranslation } from '../lib/captionLanguage';
import {
  isTranslationConfigComplete, readTranslationConfig, saveTranslationConfig,
  translateCues, type TranslationConfig,
} from '../lib/translation';
import {
  analyzeAudioBlob, analyzeAudioUrl, calculateQuickScore,
  type QuickAudioFeatures, type QuickScoreResult,
} from '../lib/quickScore';
import { normalizeRecordingMimeType } from '../lib/recordingFile';
import { chartWordsForCue, parseWordTimings, transcriptionUrlForAudio, type ChartWord, type WordTiming } from '../lib/wordTiming';

type Cue = { start: number; end: number; text: string; speaker: number | string | null };
type Clip = { id: string; title: string; sourceTitle: string; duration: number; video: string; audio: string; poster: string; cues: Cue[]; sourceType?: 'url' | 'file'; platform?: string; language?: string; authorName?: string; authorId?: string; isUserMaterial?: boolean };
type Author = { id: string; name: string; avatar: string; clips: Clip[]; isUser?: boolean; hasUserClips?: boolean };
type Library = { clipCount: number; authors: Author[]; userMaterialCount?: number };

function clipDisplayTitle(clip: Clip) {
  const title = clip.title.trim();
  const sourceTitle = clip.sourceTitle.trim();
  if (!sourceTitle || sourceTitle.endsWith(title)) return title;
  return sourceTitle;
}
type ImportJob = {
  id: string;
  kind: 'url' | 'file';
  status: 'queued' | 'downloading' | 'converting' | 'transcribing' | 'generating' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  step: string;
  error?: string | null;
  errorCode?: string | null;
  materialId?: string;
  duplicateOf?: string;
  canRetryWithBrowser?: boolean;
  canContinueWithFile?: boolean;
  sourceUrl?: string;
  originalName?: string;
  browser?: string | null;
};

const TRANSLATION_CACHE_PREFIX = 'speaking-practice:translation:v2:';
const MIN_RECORDING_SECONDS = 0.5;
const MICROPHONE_WARMUP_MS = 300;
type QuickScoreState = 'idle' | 'scoring' | 'ready' | 'error';
type DiagnosticActionState = 'idle' | 'copied' | 'saved' | 'error';
type QuickReferenceCache = { clipId: string; audioUrl: string; features: Map<number, Promise<QuickAudioFeatures>> };

const translationCacheKey = (clipId: string) => `${TRANSLATION_CACHE_PREFIX}${clipId}`;

const formatTime = (value: number) => {
  if (!Number.isFinite(value)) return '00:00';
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
};
const sentenceErrorCopy: Record<SentenceError, { title: string; body: string }> = {
  permission: { title: '麦克风未开启', body: '请在浏览器地址栏的权限设置中允许麦克风，然后重新开始。' },
  unsupported: { title: '当前浏览器无法录音', body: '请使用最新版 Chrome 或 Edge。' },
  too_short: { title: '没有录到完整内容', body: '请重新说一次，结束后点击“我说完了”。' },
  invalid_cue: { title: '这句暂时无法训练', body: '请选择其他句子。' },
  recording: { title: '录音没有完成', body: '请检查麦克风是否仍然可用，然后重新录制。' },
};

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>;
}
function LoadingState() {
  return <main className="loading-state"><CircleNotch size={22} className="spin" /><p>正在整理训练片段…</p></main>;
}

function contourPath(values: number[], width = 240, height = 58, minValue = Math.min(...values), maxValue = Math.max(...values)): string {
  if (!values.length) return '';
  const range = Math.max(maxValue - minValue, 0.001);
  return values.map((value, index) => {
    const x = values.length === 1 ? 0 : index / (values.length - 1) * width;
    const y = height - (value - minValue) / range * height;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function QuickContourChart({ title, reference, recording, words, activeWordIndex, onActiveWordChange, onWordPlay }: { title: string; reference: number[]; recording: number[]; words: ChartWord[]; activeWordIndex: number | null; onActiveWordChange: (index: number | null) => void; onWordPlay: (index: number) => void }) {
  const allValues = [...reference, ...recording];
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const getWordIndex = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999, (clientX - rect.left) / Math.max(rect.width, 1)));
    const containing = words.findIndex((word) => ratio >= word.startRatio && ratio <= word.endRatio);
    if (containing >= 0) return containing;
    return words.reduce((closestIndex, word, index) => {
      const closest = words[closestIndex];
      const distance = Math.abs((word.startRatio + word.endRatio) / 2 - ratio);
      const closestDistance = Math.abs((closest.startRatio + closest.endRatio) / 2 - ratio);
      return distance < closestDistance ? index : closestIndex;
    }, 0);
  };
  const markerX = activeWordIndex === null ? null : (words[activeWordIndex].startRatio + words[activeWordIndex].endRatio) / 2 * 240;
  return <div className="quick-score-chart">
    <div className="quick-score-chart-heading"><span>{title}</span><span><i className="chart-key reference" />范例 <i className="chart-key recording" />我的</span></div>
    <svg viewBox="0 0 240 58" role="img" aria-label={`${title}，黑线为范例，红线为我的录音`} preserveAspectRatio="none" onPointerMove={(event) => onActiveWordChange(getWordIndex(event.clientX, event.currentTarget))} onPointerLeave={() => onActiveWordChange(null)}>
      <path className="quick-score-chart-grid" d="M0 29H240" />
      <path className="quick-score-chart-reference" d={contourPath(reference, 240, 58, min, max)} />
      <path className="quick-score-chart-recording" d={contourPath(recording, 240, 58, min, max)} />
      {markerX !== null && <line className="quick-score-chart-marker" x1={markerX} x2={markerX} y1="0" y2="58" />}
    </svg>
    <div className="quick-score-word-strip" aria-label={`${title}对应的示范句文字`}>
      {words.map((word, index) => <button type="button" key={`${word.text}-${index}`} className={index === activeWordIndex ? 'active' : ''} style={{ left: `${word.startRatio * 100}%`, width: `${Math.max(1.5, (word.endRatio - word.startRatio) * 100)}%` }} title={`点击播放“${word.text}”`} aria-label={`播放“${word.text}”并查看对应曲线`} aria-pressed={index === activeWordIndex} onMouseEnter={() => onActiveWordChange(index)} onFocus={() => onActiveWordChange(index)} onBlur={() => onActiveWordChange(null)} onClick={() => { onActiveWordChange(index); onWordPlay(index); }}>{word.text}</button>)}
    </div>
  </div>;
}

function QuickScoreDiagnosticContent({
  quickScore,
  diagnosticActionState,
  diagnosticActionMessage,
  onCopy,
  onSave,
}: {
  quickScore: QuickScoreResult;
  diagnosticActionState: DiagnosticActionState;
  diagnosticActionMessage: string;
  onCopy: () => void;
  onSave: () => void;
}) {
  return <>
    <div className="quick-score-diagnostic-grid">
      <div><span>范例时长</span><strong>{quickScore.diagnostic.reference.durationSeconds.toFixed(2)} 秒</strong></div>
      <div><span>我的时长</span><strong>{quickScore.diagnostic.recording.durationSeconds.toFixed(2)} 秒</strong></div>
      <div><span>范例有效人声</span><strong>{Math.round(quickScore.diagnostic.reference.voicedRatio * 100)}%</strong></div>
      <div><span>我的有效人声</span><strong>{Math.round(quickScore.diagnostic.recording.voicedRatio * 100)}%</strong></div>
      <div><span>音高相似度</span><strong>{quickScore.metrics.pitchSimilarity}</strong></div>
      <div><span>力度相似度</span><strong>{quickScore.metrics.energySimilarity}</strong></div>
      <div><span>我的爆音比例</span><strong>{(quickScore.diagnostic.recording.clippingRatio * 100).toFixed(2)}%</strong></div>
    </div>
    <p className="quick-score-diagnostic-hint">完整诊断包含两边的 64 点音高和力度曲线。</p>
    <div className="quick-score-diagnostic-actions">
      <button type="button" onClick={onCopy}>{diagnosticActionState === 'copied' ? '诊断数据已复制' : '复制完整诊断数据'}</button>
      <button type="button" onClick={onSave}>保存当前录音</button>
    </div>
    {diagnosticActionState === 'copied' && <small className="quick-score-diagnostic-status">{diagnosticActionMessage || '评分诊断数据已复制。'}</small>}
    {diagnosticActionState === 'saved' && <small className="quick-score-diagnostic-status">{diagnosticActionMessage || '录音已保存到本地诊断目录。'}</small>}
    {diagnosticActionState === 'error' && <small className="quick-score-diagnostic-status error">{diagnosticActionMessage || '操作失败，请稍后再试。'}</small>}
  </>;
}

function QuickScoreDetailsModal({
  quickScore,
  cueText,
  audioUrl,
  cueStart,
  cueEnd,
  diagnosticActionState,
  diagnosticActionMessage,
  onClose,
  onCopy,
  onSave,
}: {
  quickScore: QuickScoreResult;
  cueText: string;
  audioUrl: string;
  cueStart: number;
  cueEnd: number;
  diagnosticActionState: DiagnosticActionState;
  diagnosticActionMessage: string;
  onClose: () => void;
  onCopy: () => void;
  onSave: () => void;
}) {
  const [wordTimings, setWordTimings] = useState<WordTiming[]>([]);
  const [wordTimingStatus, setWordTimingStatus] = useState<'loading' | 'generating' | 'ready' | 'fallback'>('loading');
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [playingWordIndex, setPlayingWordIndex] = useState<number | null>(null);
  const wordAudioRef = useRef<HTMLAudioElement | null>(null);
  const wordStopTimerRef = useRef<number | null>(null);
  useEffect(() => {
    let mounted = true;
    const url = transcriptionUrlForAudio(audioUrl);
    setWordTimings([]);
    setWordTimingStatus('loading');
    if (!url) {
      setWordTimingStatus('fallback');
      return () => { mounted = false; };
    }
    void (async () => {
      try {
        let response = await fetch(url);
        if (!response.ok) {
          setWordTimingStatus('generating');
          response = await fetch(`/api/word-timings?audio=${encodeURIComponent(audioUrl)}`);
        }
        if (!response.ok) throw new Error(`词级时间轴读取失败：${response.status}`);
        const timings = parseWordTimings(await response.json());
        if (!mounted) return;
        setWordTimings(timings);
        setWordTimingStatus(timings.length ? 'ready' : 'fallback');
      } catch {
        if (mounted) setWordTimingStatus('fallback');
      }
    })();
    return () => { mounted = false; };
  }, [audioUrl, cueStart, cueEnd]);
  const words = chartWordsForCue(cueText, cueStart, cueEnd, wordTimings);
  useEffect(() => () => {
    if (wordStopTimerRef.current !== null) window.clearTimeout(wordStopTimerRef.current);
    wordAudioRef.current?.pause();
    window.speechSynthesis?.cancel();
  }, []);
  const playWord = async (index: number) => {
    const word = words[index];
    if (!word) return;
    if (wordStopTimerRef.current !== null) window.clearTimeout(wordStopTimerRef.current);
    wordAudioRef.current?.pause();
    window.speechSynthesis?.cancel();
    setPlayingWordIndex(index);
    if (word.endSeconds > word.startSeconds) {
      const audio = wordAudioRef.current ?? new Audio(audioUrl);
      wordAudioRef.current = audio;
      const playbackStart = Math.max(cueStart, word.startSeconds - 0.06);
      const playbackEnd = Math.min(cueEnd, word.endSeconds + 0.08);
      audio.currentTime = Math.max(0, playbackStart);
      try {
        await audio.play();
        wordStopTimerRef.current = window.setTimeout(() => {
          audio.pause();
          setPlayingWordIndex(null);
        }, Math.max(160, (playbackEnd - playbackStart) * 1000));
      } catch {
        setPlayingWordIndex(null);
      }
      return;
    }
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(word.text);
      utterance.lang = /[\u3400-\u9fff]/.test(word.text) ? 'zh-CN' : 'en-US';
      utterance.onend = () => setPlayingWordIndex(null);
      utterance.onerror = () => setPlayingWordIndex(null);
      window.speechSynthesis.speak(utterance);
    } else {
      setPlayingWordIndex(null);
    }
  };
  return <div className="modal-backdrop quick-score-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="api-modal quick-score-modal" role="dialog" aria-modal="true" aria-labelledby="quick-score-details-title">
      <header>
        <div><span className="eyebrow">评分细节</span><h2 id="quick-score-details-title">语气与节奏对照</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭评分细节" title="关闭"><X size={20} /></button>
      </header>
      <div className="quick-score-modal-body">
        <div className="quick-score-modal-score">
          <div><span className="eyebrow">快速模仿分</span><strong>{quickScore.score}<small>/100</small></strong></div>
          <span className={`quick-score-confidence ${quickScore.confidence}`}>{quickScore.confidenceLabel}</span>
        </div>
        <div className="quick-score-modal-section-heading"><span>曲线对照</span><small><i className="chart-key reference" />范例 <i className="chart-key recording" />我的</small></div>
        <div className="quick-score-visuals quick-score-modal-visuals">
          <QuickContourChart title="语调曲线" reference={quickScore.visuals.referencePitchContour} recording={quickScore.visuals.recordingPitchContour} words={words} activeWordIndex={activeWordIndex} onActiveWordChange={setActiveWordIndex} onWordPlay={playWord} />
          <QuickContourChart title="声音力度" reference={quickScore.visuals.referenceEnergyContour} recording={quickScore.visuals.recordingEnergyContour} words={words} activeWordIndex={activeWordIndex} onActiveWordChange={setActiveWordIndex} onWordPlay={playWord} />
        </div>
        <p className="quick-score-word-hint">悬停曲线或点击下面的词语，查看对应位置并播放示范发音。{playingWordIndex !== null ? `正在播放“${words[playingWordIndex]?.text ?? ''}”。` : ''}{wordTimingStatus === 'ready' ? '词语位置来自示范音频的真实词级时间轴。' : wordTimingStatus === 'loading' ? '正在读取示范音频的词级时间轴…' : wordTimingStatus === 'generating' ? '当前素材缺少时间轴，正在用本地语音识别生成，首次需要一点时间…' : '当前素材没有可用的词级时间轴，点击词语会播放浏览器发音，曲线位置仅作大致参考。'}</p>
        {quickScore.notes.length > 0 && <ul className="quick-score-notes">{quickScore.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        <p className="quick-score-caption">黑线是范例，红线是你的录音。这里重点看语气、节奏和声音力度。</p>
        <details className="quick-score-diagnostic">
          <summary>查看评分诊断数据</summary>
          <QuickScoreDiagnosticContent quickScore={quickScore} diagnosticActionState={diagnosticActionState} diagnosticActionMessage={diagnosticActionMessage} onCopy={onCopy} onSave={onSave} />
        </details>
      </div>
      <footer><button type="button" className="secondary-button" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;
}

export default function PracticeStudio() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState('');
  const [authorIndex, setAuthorIndex] = useState(0);
  const [expandedAuthorIndex, setExpandedAuthorIndex] = useState<number | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [selectedCueIndex, setSelectedCueIndex] = useState(0);
  const [sentenceState, dispatchSentence] = useReducer(sentenceReducer, initialSentenceState);
  const [sentenceRecordedUrl, setSentenceRecordedUrl] = useState('');
  const [sentenceRecordedHasVideo, setSentenceRecordedHasVideo] = useState(false);
  const [quickScore, setQuickScore] = useState<QuickScoreResult | null>(null);
  const [showQuickScoreDetails, setShowQuickScoreDetails] = useState(false);
  const [quickScoreState, setQuickScoreState] = useState<QuickScoreState>('idle');
  const [quickScoreError, setQuickScoreError] = useState('');
  const [diagnosticActionState, setDiagnosticActionState] = useState<DiagnosticActionState>('idle');
  const [diagnosticActionMessage, setDiagnosticActionMessage] = useState('');
  const [completedCues, setCompletedCues] = useState<Set<string>>(() => new Set());
  const [comparePaused, setComparePaused] = useState(false);
  const [clipCompletion, setClipCompletion] = useState(false);
  const [translationApiUrl, setTranslationApiUrl] = useState('');
  const [translationApiKey, setTranslationApiKey] = useState('');
  const [translationModel, setTranslationModel] = useState('');
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState('');
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [showApiConfig, setShowApiConfig] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiUrlDraft, setApiUrlDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [apiConfigError, setApiConfigError] = useState('');
  const [showAddVideo, setShowAddVideo] = useState(false);
  const [isAddVideoClosing, setIsAddVideoClosing] = useState(false);
  const [importTab, setImportTab] = useState<'url' | 'file'>('url');
  const [urlDraft, setUrlDraft] = useState('');
  const [importError, setImportError] = useState('');
  const [importQueuedNotice, setImportQueuedNotice] = useState('');
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [completedImportNotice, setCompletedImportNotice] = useState('');
  const [removingJobIds, setRemovingJobIds] = useState<Set<string>>(() => new Set());
  const [capabilities, setCapabilities] = useState<{ modelReady: boolean; javascriptRuntime?: boolean; browsers: string[] } | null>(null);

  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const userPlaybackRef = useRef<HTMLMediaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sentenceRecordedBlobRef = useRef<Blob | null>(null);
  const quickScoreRequestRef = useRef(0);
  const autoScoreKeyRef = useRef('');
  const quickReferenceCacheRef = useRef<QuickReferenceCache | null>(null);
  const recordingStartedAtRef = useRef(0);
  const sentenceUrlRef = useRef('');
  const activeCueRef = useRef<HTMLButtonElement>(null);
  const authorButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cueEndRef = useRef<number | null>(null);
  const cueCompletionRef = useRef<(() => void) | null>(null);
  const cueFrameRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const addVideoButtonRef = useRef<HTMLButtonElement>(null);
  const importModalRef = useRef<HTMLElement>(null);
  const importClosingTimerRef = useRef<number | null>(null);
  const showAddVideoRef = useRef(false);
  const comparisonTimerRef = useRef<number | null>(null);
  const recordingLimitTimerRef = useRef<number | null>(null);
  const autoPlayedRecordingRef = useRef('');
  const translationOperationRef = useRef(0);
  const operationRef = useRef(0);
  const phaseRef = useRef(sentenceState.phase);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobsInitializedRef = useRef(false);
  const handledImportRef = useRef(new Set<string>());
  const pendingCancelledImportRef = useRef(new Set<string>());
  const dismissedImportRef = useRef(new Set<string>());
  const importRemovalTimersRef = useRef(new Map<string, number[]>());
  const importNoticeTimerRef = useRef<number | null>(null);

  const author = library?.authors[authorIndex];
  const clip = author?.clips[clipIndex];
  const selectedCue = clip?.cues[selectedCueIndex];
  const activeCueIndex = selectedCueIndex;
  const canOfferChineseTranslation = clip ? shouldOfferChineseTranslation(clip.cues.map((cue) => cue.text)) : false;
  const translationConfigured = isTranslationConfigComplete({ apiUrl: translationApiUrl, apiKey: translationApiKey, model: translationModel });
  const isSentenceRecording = sentenceState.phase === 'recording_user' || sentenceState.phase === 'processing_recording';
  const isAnyRecording = isSentenceRecording;
  const currentCueKey = author && clip ? `${author.id}:${clip.id}:${selectedCueIndex}` : '';

  const loadLibrary = async (selectClipId = '') => {
    try {
      let response = await fetch('/api/library');
      if (!response.ok) response = await fetch('/data/library.json');
      if (!response.ok) throw new Error('训练数据暂未生成');
      const data = await response.json() as Library;
      setLibrary(data);
      const selectedAuthorIndex = selectClipId
        ? data.authors.findIndex((item) => item.clips.some((itemClip) => itemClip.id === selectClipId))
        : -1;
      const nextAuthorIndex = selectedAuthorIndex >= 0
        ? selectedAuthorIndex
        : Math.min(authorIndex, Math.max(0, data.authors.length - 1));
      const nextAuthor = data.authors[nextAuthorIndex];
      const selectedClipIndex = selectClipId && nextAuthor
        ? nextAuthor.clips.findIndex((item) => item.id === selectClipId)
        : -1;
      const nextClipIndex = selectedClipIndex >= 0
        ? selectedClipIndex
        : Math.min(clipIndex, Math.max(0, (nextAuthor?.clips.length ?? 1) - 1));
      setAuthorIndex(nextAuthorIndex);
      setExpandedAuthorIndex(null);
      setClipIndex(nextClipIndex);
      setSelectedCueIndex(0);
      setCurrentTime(0);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '训练数据暂未生成');
    }
  };

  const announceImportComplete = (job: ImportJob) => {
    setCompletedImportNotice(job.originalName || job.sourceUrl || '视频');
    if (importNoticeTimerRef.current !== null) window.clearTimeout(importNoticeTimerRef.current);
    importNoticeTimerRef.current = window.setTimeout(() => {
      setCompletedImportNotice('');
      importNoticeTimerRef.current = null;
    }, 6500);
  };

  useEffect(() => {
    void loadLibrary();
    fetch('/api/system/capabilities').then((response) => response.ok ? response.json() : null).then((data) => {
      if (data) setCapabilities(data as { modelReady: boolean; javascriptRuntime?: boolean; browsers: string[] });
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const refreshJobs = async () => {
      try {
        const response = await fetch('/api/imports?limit=30');
        if (!response.ok) return;
        const data = await response.json() as ImportJob[];
        if (jobsInitializedRef.current) {
          for (const job of data) {
            if (job.status === 'completed' && job.materialId && !handledImportRef.current.has(job.id)) {
              handledImportRef.current.add(job.id);
              announceImportComplete(job);
              void loadLibrary(job.materialId);
            }
          }
        } else {
          data.filter((job) => job.status === 'completed').forEach((job) => handledImportRef.current.add(job.id));
          jobsInitializedRef.current = true;
        }
        setJobs(data.filter((job) => {
          if (job.status === 'completed' && !showAddVideoRef.current) {
            dismissedImportRef.current.add(job.id);
            return false;
          }
          if (dismissedImportRef.current.has(job.id)) return false;
          if (job.status === 'cancelled') return pendingCancelledImportRef.current.has(job.id);
          return true;
        }));
      } catch {
        // The static Astro preview can run without the optional local service.
      }
    };
    void refreshJobs();
    const timer = window.setInterval(() => { void refreshJobs(); }, 1500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const config = readTranslationConfig(window.localStorage);
    setTranslationApiUrl(config.apiUrl);
    setTranslationApiKey(config.apiKey);
    setTranslationModel(config.model);
    setApiUrlDraft(config.apiUrl);
    setApiKeyDraft(config.apiKey);
    setModelDraft(config.model);
  }, []);
  useEffect(() => { phaseRef.current = sentenceState.phase; }, [sentenceState.phase]);
  useEffect(() => { sentenceUrlRef.current = sentenceRecordedUrl; }, [sentenceRecordedUrl]);
  useEffect(() => {
    if (!library) return;
    const frame = window.requestAnimationFrame(() => {
      authorButtonRefs.current[authorIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [authorIndex, library]);
  useEffect(() => {
    if (!clip) return;
    try {
      const cached = window.localStorage.getItem(translationCacheKey(clip.id));
      setTranslations(cached ? JSON.parse(cached) as Record<string, string> : {});
    } catch {
      setTranslations({});
    }
    setTranslationEnabled(false);
    setTranslationError('');
    setTranslationLoading(false);
  }, [clip?.id]);
  useEffect(() => {
    if (cameraReady && cameraStreamRef.current) attachCameraPreview(cameraStreamRef.current);
  }, [cameraReady, isAnyRecording, sentenceRecordedUrl]);
  useEffect(() => {
    quickScoreRequestRef.current += 1;
    setQuickScore(null);
    setShowQuickScoreDetails(false);
    setQuickScoreState('idle');
    setQuickScoreError('');
    setDiagnosticActionState('idle');
    setDiagnosticActionMessage('');
    if (!clip?.audio || !selectedCue) return;
    void preloadQuickReference(clip, selectedCue, selectedCueIndex);
  }, [clip?.id, clip?.audio, selectedCueIndex, selectedCue?.start, selectedCue?.end]);
  useEffect(() => { activeCueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [activeCueIndex]);
  useEffect(() => {
    if (!isAnyRecording) return;
    const timer = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isAnyRecording]);

  const clearTimer = (ref: MutableRefObject<number | null>) => {
    if (ref.current !== null) window.clearTimeout(ref.current);
    ref.current = null;
  };
  const cancelCueBoundary = () => {
    cueEndRef.current = null;
    cueCompletionRef.current = null;
    if (cueFrameRef.current !== null) window.cancelAnimationFrame(cueFrameRef.current);
    cueFrameRef.current = null;
  };
  const stopMicrophoneStream = () => {
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
  };
  const revokeSentenceRecording = () => {
    quickScoreRequestRef.current += 1;
    autoScoreKeyRef.current = '';
    sentenceRecordedBlobRef.current = null;
    if (sentenceUrlRef.current) URL.revokeObjectURL(sentenceUrlRef.current);
    sentenceUrlRef.current = '';
    userPlaybackRef.current = null;
    setSentenceRecordedUrl('');
    setSentenceRecordedHasVideo(false);
    setQuickScore(null);
    setShowQuickScoreDetails(false);
    setQuickScoreState('idle');
    setQuickScoreError('');
    setDiagnosticActionState('idle');
    setDiagnosticActionMessage('');
  };
  const stopAllPlayback = () => {
    sourceVideoRef.current?.pause();
    userPlaybackRef.current?.pause();
    cancelCueBoundary();
    clearTimer(transitionTimerRef);
    clearTimer(comparisonTimerRef);
    setComparePaused(false);
  };
  const invalidatePendingOperations = () => {
    operationRef.current += 1;
    stopAllPlayback();
    clearTimer(recordingLimitTimerRef);
  };

  const attachCameraPreview = (stream: MediaStream) => {
    const preview = cameraVideoRef.current;
    if (!preview) return;
    if (preview.srcObject !== stream) preview.srcObject = stream;
    preview.muted = true;
    preview.volume = 0;
    void preview.play().catch(() => undefined);
  };

  useEffect(() => () => {
    operationRef.current += 1;
    cancelCueBoundary();
    clearTimer(transitionTimerRef);
    clearTimer(comparisonTimerRef);
    clearTimer(recordingLimitTimerRef);
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (sentenceUrlRef.current) URL.revokeObjectURL(sentenceUrlRef.current);
    for (const timers of importRemovalTimersRef.current.values()) timers.forEach((timer) => window.clearTimeout(timer));
    importRemovalTimersRef.current.clear();
  }, []);

  const finishCuePlayback = () => {
    const video = sourceVideoRef.current;
    const end = cueEndRef.current;
    const completion = cueCompletionRef.current;
    if (video && end !== null) {
      video.pause();
      video.currentTime = end;
      setCurrentTime(end);
    }
    cancelCueBoundary();
    completion?.();
  };
  const checkCueBoundary = () => {
    const video = sourceVideoRef.current;
    if (!video || cueEndRef.current === null) return;
    if (hasCueReachedEnd(video.currentTime, cueEndRef.current) || video.ended) return finishCuePlayback();
    cueFrameRef.current = window.requestAnimationFrame(checkCueBoundary);
  };
  const playCue = async (cue: Cue, onComplete: () => void) => {
    const video = sourceVideoRef.current;
    if (!video || !isValidCue(cue)) return false;
    stopAllPlayback();
    video.currentTime = cue.start;
    setCurrentTime(cue.start);
    cueEndRef.current = cue.end;
    cueCompletionRef.current = onComplete;
    try {
      await video.play();
      cueFrameRef.current = window.requestAnimationFrame(checkCueBoundary);
      return true;
    } catch {
      cancelCueBoundary();
      return false;
    }
  };

  const chooseMimeType = (stream: MediaStream) => {
    const candidates = stream.getVideoTracks().length
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type));
  };
  const configureRecorder = (stream: MediaStream) => {
    const recordingStream = typeof stream.clone === 'function' ? stream.clone() : stream;
    const ownsRecordingStream = recordingStream !== stream;
    const mimeType = chooseMimeType(recordingStream);
    const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
    const releaseRecordingStream = () => {
      if (ownsRecordingStream) recordingStream.getTracks().forEach((track) => track.stop());
    };
    recorder.onerror = () => {
      releaseRecordingStream();
      dispatchSentence({ type: 'FAIL', error: 'recording' });
    };
    recorder.onstop = () => {
      const elapsedSeconds = Math.max(0, (performance.now() - recordingStartedAtRef.current) / 1000);
      const hasVideo = stream.getVideoTracks().length > 0;
      const blobType = recorder.mimeType || chunksRef.current[0]?.type || (hasVideo ? 'video/webm' : 'audio/webm');
      const blob = new Blob(chunksRef.current, { type: blobType });
      chunksRef.current = [];
      releaseRecordingStream();
      clearTimer(recordingLimitTimerRef);
      stopMicrophoneStream();
      if (!blob.size || elapsedSeconds < MIN_RECORDING_SECONDS) return dispatchSentence({ type: 'FAIL', error: 'too_short' });
      revokeSentenceRecording();
      sentenceRecordedBlobRef.current = blob;
      const url = URL.createObjectURL(blob);
      sentenceUrlRef.current = url;
      setSentenceRecordedUrl(url);
      setSentenceRecordedHasVideo(hasVideo || blobType.startsWith('video/'));
      setCompletedCues((current) => new Set(current).add(currentCueKey));
      dispatchSentence({ type: 'RECORDING_READY' });
    };
    mediaRecorderRef.current = recorder;
    return recorder;
  };

  const ensureCamera = async () => {
    setCameraError('');
    const existing = cameraStreamRef.current;
    if (existing?.getVideoTracks().some((track) => track.readyState === 'live')) {
      attachCameraPreview(existing);
      setCameraReady(true);
      return existing;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      cameraStreamRef.current = stream;
      attachCameraPreview(stream);
      setCameraReady(true);
      return stream;
    } catch {
      setCameraError('无法打开摄像头，请在浏览器设置中允许摄像头和麦克风权限。');
      return null;
    }
  };
  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
    }
    setCameraReady(false);
  };
  const toggleCamera = async () => {
    if (isAnyRecording) return;
    const hasLiveVideo = Boolean(cameraStreamRef.current?.getVideoTracks().some((track) => track.readyState === 'live'));
    if (cameraReady || hasLiveVideo) {
      stopCamera();
      return;
    }
    await ensureCamera();
  };
  const ensureSentenceStream = async () => {
    const cameraStream = cameraStreamRef.current;
    if (cameraStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      attachCameraPreview(cameraStream);
      return cameraStream;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      microphoneStreamRef.current = stream;
      return stream;
    } catch { return null; }
  };

  const resetSentencePractice = (keepPosition = true) => {
    invalidatePendingOperations();
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
    stopMicrophoneStream();
    revokeSentenceRecording();
    dispatchSentence({ type: 'RESET' });
    setClipCompletion(false);
    if (keepPosition && selectedCue && sourceVideoRef.current) {
      sourceVideoRef.current.currentTime = selectedCue.start;
      setCurrentTime(selectedCue.start);
    }
  };
  const selectSentence = (index: number) => {
    if (!clip || isAnyRecording || index < 0 || index >= clip.cues.length) return;
    invalidatePendingOperations();
    revokeSentenceRecording();
    dispatchSentence({ type: 'RESET' });
    setSelectedCueIndex(index);
    setClipCompletion(false);
    const start = clip.cues[index].start;
    if (sourceVideoRef.current) sourceVideoRef.current.currentTime = start;
    setCurrentTime(start);
  };
  const getQuickReferenceFeatures = (targetClip: Clip, cue: Cue, cueIndex: number): Promise<QuickAudioFeatures> => {
    const current = quickReferenceCacheRef.current;
    const cache = current && current.clipId === targetClip.id && current.audioUrl === targetClip.audio
      ? current
      : { clipId: targetClip.id, audioUrl: targetClip.audio, features: new Map<number, Promise<QuickAudioFeatures>>() };
    quickReferenceCacheRef.current = cache;
    const cached = cache.features.get(cueIndex);
    if (cached) return cached;
    const pending = analyzeAudioUrl(targetClip.audio, cue.start, cue.end).catch((error) => {
      cache.features.delete(cueIndex);
      throw error;
    });
    cache.features.set(cueIndex, pending);
    return pending;
  };
  const preloadQuickReference = (targetClip: Clip, cue: Cue, cueIndex: number) => {
    void getQuickReferenceFeatures(targetClip, cue, cueIndex).catch(() => undefined);
  };
  const scoreCurrentRecording = async () => {
    if (!clip || !selectedCue || !sentenceRecordedBlobRef.current) return;
    const recordingBlob = sentenceRecordedBlobRef.current;
    const request = ++quickScoreRequestRef.current;
    setQuickScore(null);
    setShowQuickScoreDetails(false);
    setQuickScoreError('');
    setDiagnosticActionState('idle');
    setDiagnosticActionMessage('');
    setQuickScoreState('scoring');
    try {
      const reference = await getQuickReferenceFeatures(clip, selectedCue, selectedCueIndex);
      const recording = await analyzeAudioBlob(recordingBlob);
      const result = calculateQuickScore(reference, recording);
      if (request !== quickScoreRequestRef.current) return;
      setQuickScore(result);
      setQuickScoreState('ready');
    } catch (error) {
      if (request !== quickScoreRequestRef.current) return;
      setQuickScoreState('error');
      setQuickScoreError(error instanceof Error ? error.message : '快速评分暂时失败，请重新录制后再试。');
    }
  };
  const buildDiagnosticPayload = () => {
    if (!quickScore || !clip || !selectedCue) return null;
    return {
      format: 'speaking-practice.quick-score.v1',
      createdAt: new Date().toISOString(),
      clip: { id: clip.id, title: clip.title },
      cue: { index: selectedCueIndex, start: selectedCue.start, end: selectedCue.end, text: selectedCue.text },
      score: quickScore,
    };
  };
  const copyQuickScoreDiagnostic = async () => {
    const payload = buildDiagnosticPayload();
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setDiagnosticActionState('copied');
      setDiagnosticActionMessage('评分诊断数据已复制。');
    } catch {
      setDiagnosticActionState('error');
      setDiagnosticActionMessage('复制诊断数据失败，请检查浏览器剪贴板权限。');
    }
  };
  const saveCurrentRecording = async () => {
    const blob = sentenceRecordedBlobRef.current;
    if (!blob) return;
    const picker = (window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable: () => Promise<{ write: (value: Blob) => Promise<void>; close: () => Promise<void> }> }>;
    }).showSaveFilePicker;
    const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const pickerMimeType = normalizeRecordingMimeType(blob.type);
    try {
      if (picker) {
        const handle = await picker({
          suggestedName: `speaking-practice-${selectedCueIndex + 1}.${extension}`,
          types: [{ description: '口播训练录音', accept: { [pickerMimeType]: [`.${extension}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setDiagnosticActionMessage('录音已保存到你选择的位置。');
      } else {
        const response = await fetch('/api/diagnostics/recording', {
          method: 'POST',
          headers: {
            'Content-Type': blob.type || 'audio/webm',
            'X-Clip-Id': clip?.id ?? 'clip',
            'X-Cue-Index': String(selectedCueIndex + 1),
          },
          body: blob,
        });
        if (!response.ok) {
          let detail = '';
          try {
            const payload = await response.json() as { detail?: string };
            detail = payload.detail ?? '';
          } catch {
            detail = '';
          }
          throw new Error(detail || `本地服务保存失败（${response.status}）。`);
        }
        const saved = await response.json() as { filename?: string };
        setDiagnosticActionMessage(saved.filename ? `录音已保存到本地诊断目录：${saved.filename}` : '录音已保存到本地诊断目录。');
      }
      setDiagnosticActionState('saved');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setDiagnosticActionState('error');
      setDiagnosticActionMessage(error instanceof Error ? error.message : '录音保存失败，请稍后再试。');
    }
  };
  useEffect(() => {
    if (!sentenceRecordedUrl || !sentenceRecordedBlobRef.current || !clip || !selectedCue) return;
    const scoreKey = `${clip.id}:${selectedCueIndex}:${sentenceRecordedUrl}`;
    if (autoScoreKeyRef.current === scoreKey) return;
    autoScoreKeyRef.current = scoreKey;
    void scoreCurrentRecording();
  }, [sentenceRecordedUrl, clip?.id, selectedCueIndex, selectedCue?.start, selectedCue?.end]);
  const chooseAuthor = (index: number) => {
    if (isAnyRecording) return;
    invalidatePendingOperations(); revokeSentenceRecording(); dispatchSentence({ type: 'RESET' });
    setAuthorIndex(index); setExpandedAuthorIndex(index); setClipIndex(0); setSelectedCueIndex(0); setCurrentTime(0); setIsPlaying(false);
  };
  const chooseClip = (index: number) => {
    if (isAnyRecording) return;
    invalidatePendingOperations(); revokeSentenceRecording(); dispatchSentence({ type: 'RESET' });
    setClipIndex(index); setSelectedCueIndex(0); setCurrentTime(0); setIsPlaying(false);
  };

  const dismissCompletedImports = () => {
    jobs.filter((job) => job.status === 'completed').forEach((job) => dismissedImportRef.current.add(job.id));
    setJobs((current) => current.filter((job) => job.status !== 'completed'));
  };
  const closeAddVideo = () => {
    showAddVideoRef.current = false;
    dismissCompletedImports();
    if (importClosingTimerRef.current !== null) {
      window.clearTimeout(importClosingTimerRef.current);
      importClosingTimerRef.current = null;
    }
    setIsAddVideoClosing(false);
    setShowAddVideo(false);
  };
  const openAddVideo = () => {
    showAddVideoRef.current = true;
    setIsAddVideoClosing(false);
    setImportError('');
    setImportQueuedNotice('');
    setShowAddVideo(true);
  };
  const waitInBackground = () => {
    const modal = importModalRef.current;
    const target = addVideoButtonRef.current;
    if (!modal || !target) {
      closeAddVideo();
      return;
    }
    const modalRect = modal.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const modalCenterX = modalRect.left + modalRect.width / 2;
    const modalCenterY = modalRect.top + modalRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;
    modal.style.setProperty('--close-x', `${targetCenterX - modalCenterX}px`);
    modal.style.setProperty('--close-y', `${targetCenterY - modalCenterY}px`);
    showAddVideoRef.current = false;
    dismissCompletedImports();
    setIsAddVideoClosing(true);
    if (importClosingTimerRef.current !== null) window.clearTimeout(importClosingTimerRef.current);
    importClosingTimerRef.current = window.setTimeout(() => {
      setShowAddVideo(false);
      setIsAddVideoClosing(false);
      importClosingTimerRef.current = null;
    }, 340);
  };
  const readApiError = async (response: Response, fallback: string) => {
    try {
      const payload = await response.json() as { detail?: string };
      return payload.detail || fallback;
    } catch {
      return fallback;
    }
  };
  const appendImportedJob = (job: ImportJob) => {
    setJobs((current) => {
      const existingIndex = current.findIndex((item) => item.id === job.id);
      if (existingIndex < 0) return [...current, job];
      const next = [...current];
      next[existingIndex] = job;
      return next;
    });
  };
  const enqueueUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = urlDraft.trim();
    if (importSubmitting) return;
    if (!url) {
      setImportError('请先粘贴视频网址。');
      return;
    }
    setImportError('');
    setImportQueuedNotice('');
    setImportSubmitting(true);
    try {
      const response = await fetch('/api/imports/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error(await readApiError(response, '网址暂时无法加入队列。'));
      const job = await response.json() as ImportJob;
      setUrlDraft('');
      appendImportedJob(job);
      setImportQueuedNotice('已加入后台处理，完成后会出现在素材库。');
    } catch (error) {
      setImportQueuedNotice('');
      setImportError(error instanceof Error ? error.message : '网址暂时无法加入队列。');
    } finally {
      setImportSubmitting(false);
    }
  };
  const enqueueFile = async (file: File, relatedJobId?: string) => {
    if (!file.name || !file.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|avi|m4v|flv|ts)$/i.test(file.name)) {
      setImportError('请选择 MP4、MOV、MKV、WebM 等视频文件。');
      return;
    }
    const formData = new FormData();
    formData.append('file', file, file.name);
    const endpoint = relatedJobId ? `/api/imports/${relatedJobId}/continue-with-file` : '/api/imports/file';
    try {
      const response = await fetch(endpoint, { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await readApiError(response, '本地视频暂时无法加入队列。'));
      const job = await response.json() as ImportJob;
      appendImportedJob(job);
      setImportError('');
      setImportQueuedNotice('已加入后台处理，完成后会出现在素材库。');
    } catch (error) {
      setImportQueuedNotice('');
      setImportError(error instanceof Error ? error.message : '本地视频暂时无法加入队列。');
    }
  };
  const enqueueFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) await enqueueFile(file);
  };
  const scheduleImportRemoval = (jobId: string) => {
    const previousTimers = importRemovalTimersRef.current.get(jobId);
    previousTimers?.forEach((timer) => window.clearTimeout(timer));
    const animationTimer = window.setTimeout(() => {
      setRemovingJobIds((current) => new Set(current).add(jobId));
      const removalTimer = window.setTimeout(() => {
        pendingCancelledImportRef.current.delete(jobId);
        dismissedImportRef.current.add(jobId);
        setJobs((current) => current.filter((item) => item.id !== jobId));
        setRemovingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
        importRemovalTimersRef.current.delete(jobId);
      }, 360);
      importRemovalTimersRef.current.set(jobId, [animationTimer, removalTimer]);
    }, 2000);
    importRemovalTimersRef.current.set(jobId, [animationTimer]);
  };
  const cancelImport = async (job: ImportJob) => {
    try {
      const response = await fetch(`/api/imports/${job.id}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error(await readApiError(response, '任务取消失败。'));
      const updated = await response.json() as ImportJob;
      pendingCancelledImportRef.current.add(updated.id);
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
      scheduleImportRemoval(updated.id);
    } catch (error) {
      pendingCancelledImportRef.current.delete(job.id);
      setImportError(error instanceof Error ? error.message : '任务取消失败。');
    }
  };
  const retryImport = async (job: ImportJob) => {
    const browser = job.browser || (job.canRetryWithBrowser ? capabilities?.browsers[0] : undefined);
    try {
      const response = await fetch(`/api/imports/${job.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(browser ? { browser } : {}),
      });
      if (!response.ok) throw new Error(await readApiError(response, '任务重试失败。'));
      const updated = await response.json() as ImportJob;
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '任务重试失败。');
    }
  };
  const deleteCurrentMaterial = async () => {
    if (!clip?.isUserMaterial || !window.confirm(`确定删除“${clip.title}”吗？本地视频和字幕也会一起删除。`)) return;
    try {
      const response = await fetch(`/api/materials/${clip.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await readApiError(response, '素材删除失败。'));
      await loadLibrary();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '素材删除失败。');
    }
  };
  const openImportedJob = (job: ImportJob) => {
    if (!job.materialId) return;
    closeAddVideo();
    void loadLibrary(job.materialId);
  };

  const playCaseOnly = async (cueOverride?: Cue) => {
    const cue = cueOverride ?? selectedCue;
    if (!cue || !isValidCue(cue)) return dispatchSentence({ type: 'FAIL', error: 'invalid_cue' });
    const hasRecording = Boolean(sentenceUrlRef.current);
    if (!hasRecording) dispatchSentence({ type: 'RESET' });
    dispatchSentence({ type: 'PLAY_A' });
    setComparePaused(false);
    await playCue(cue, () => {
      setComparePaused(false);
      if (sentenceUrlRef.current) dispatchSentence({ type: 'PLAYBACK_READY' });
      else dispatchSentence({ type: 'RESET' });
    });
  };
  const togglePlayback = async () => {
    const video = sourceVideoRef.current;
    if (!video) return;
    if (video.paused) await playCaseOnly();
    else {
      video.pause(); cancelCueBoundary();
      if (sentenceRecordedUrl) dispatchSentence({ type: 'PLAYBACK_READY' }); else dispatchSentence({ type: 'RESET' });
    }
  };

  const stopSentenceRecording = () => {
    if (phaseRef.current !== 'recording_user') return;
    clearTimer(recordingLimitTimerRef);
    dispatchSentence({ type: 'PROCESS_RECORDING' });
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
  };
  const beginSentenceRecording = (stream: MediaStream, operation: number, direct = false) => {
    if (operation !== operationRef.current) return;
    try {
      const recorder = configureRecorder(stream);
      recordingStartedAtRef.current = performance.now();
      setRecordingSeconds(0);
      recorder.start(250);
      dispatchSentence({ type: direct ? 'START_DIRECT_RECORDING' : 'START_RECORDING' });
      if (selectedCue) recordingLimitTimerRef.current = window.setTimeout(stopSentenceRecording, getRecordingLimitSeconds(selectedCue) * 1000);
    } catch {
      stopMicrophoneStream(); dispatchSentence({ type: 'FAIL', error: 'recording' });
    }
  };
  const startDirectSentenceRecording = async () => {
    if (!selectedCue || !isValidCue(selectedCue)) return dispatchSentence({ type: 'FAIL', error: 'invalid_cue' });
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return dispatchSentence({ type: 'FAIL', error: 'unsupported' });
    invalidatePendingOperations();
    const operation = operationRef.current;
    revokeSentenceRecording();
    dispatchSentence({ type: 'RESET' });
    dispatchSentence({ type: 'PREPARE' });
    const stream = await ensureSentenceStream();
    if (operation !== operationRef.current) { if (stream === microphoneStreamRef.current) stopMicrophoneStream(); return; }
    if (!stream) return dispatchSentence({ type: 'FAIL', error: 'permission' });
    await new Promise<void>((resolve) => window.setTimeout(resolve, MICROPHONE_WARMUP_MS));
    if (operation !== operationRef.current) { if (stream === microphoneStreamRef.current) stopMicrophoneStream(); return; }
    beginSentenceRecording(stream, operation, true);
  };
  const finishSentencePlayback = () => {
    setComparePaused(false);
    if (sentenceUrlRef.current) dispatchSentence({ type: 'PLAYBACK_READY' }); else dispatchSentence({ type: 'RESET' });
  };
  const playUserRecording = async () => {
    const audio = userPlaybackRef.current;
    if (!audio || !sentenceUrlRef.current) return;
    const playbackVideo = audio as HTMLVideoElement;
    if (playbackVideo.srcObject) playbackVideo.srcObject = null;
    if (audio.src !== sentenceUrlRef.current) {
      audio.src = sentenceUrlRef.current;
      audio.load();
    }
    sourceVideoRef.current?.pause(); cancelCueBoundary(); audio.pause(); audio.currentTime = 0; audio.muted = false; audio.volume = 1;
    dispatchSentence({ type: 'PLAY_B' }); setComparePaused(false);
    try { await audio.play(); } catch { finishSentencePlayback(); }
  };
  useEffect(() => {
    if (!sentenceRecordedUrl || sentenceState.phase !== 'ready_to_compare') return;
    if (autoPlayedRecordingRef.current === sentenceRecordedUrl) return;
    autoPlayedRecordingRef.current = sentenceRecordedUrl;
    const timer = window.setTimeout(() => { void playUserRecording(); }, 0);
    return () => window.clearTimeout(timer);
  }, [sentenceRecordedUrl, sentenceState.phase]);
  const toggleComparisonPause = async () => {
    const phase = phaseRef.current;
    if (phase !== 'playing_a' && phase !== 'playing_b') return;
    const media = phase === 'playing_a' ? sourceVideoRef.current : userPlaybackRef.current;
    if (!media) return;
    if (media.paused) {
      try { await media.play(); setComparePaused(false); } catch { finishSentencePlayback(); }
    } else { media.pause(); setComparePaused(true); }
  };
  const moveSentence = (delta: number, playNext = false) => {
    if (!clip || isAnyRecording) return;
    if (delta > 0 && selectedCueIndex === clip.cues.length - 1) {
      resetSentencePractice(); setClipCompletion(true); return;
    }
    const nextIndex = Math.max(0, Math.min(clip.cues.length - 1, selectedCueIndex + delta));
    selectSentence(nextIndex);
    if (playNext) void playCaseOnly(clip.cues[nextIndex]);
  };
  const sentenceRecordAction = () => {
    if (sentenceState.phase === 'recording_user') return stopSentenceRecording();
    if (['preparing_permission', 'playing_example', 'transitioning', 'processing_recording', 'playing_a', 'playing_b'].includes(sentenceState.phase)) return;
    if (sentenceState.error === 'permission') return startDirectSentenceRecording();
    if (sentenceRecordedUrl || sentenceState.phase === 'ready_to_compare' || sentenceState.phase === 'error') {
      resetSentencePractice();
      return startDirectSentenceRecording();
    }
    return startDirectSentenceRecording();
  };
  const sentenceButtonLabel = () => {
    const labels: Partial<Record<typeof sentenceState.phase, string>> = {
      preparing_permission: '正在检查麦克风', playing_example: '正在播放示范', transitioning: '准备开始录音',
      recording_user: '我说完了', processing_recording: '正在整理录音', ready_to_compare: '重新录制',
    };
    if (sentenceState.error === 'permission') return '重新检查';
    if (sentenceState.error === 'too_short' || sentenceState.error === 'recording') return '重新录制';
    if (sentenceRecordedUrl) return '重新录制';
    return labels[sentenceState.phase] ?? '录制';
  };

  const openApiConfig = () => {
    setApiUrlDraft(translationApiUrl);
    setApiKeyDraft(translationApiKey);
    setModelDraft(translationModel);
    setApiConfigError('');
    setShowApiConfig(true);
  };
  const translateCurrentClip = async (configOverride?: TranslationConfig) => {
    if (!clip) return;
    const config = configOverride ?? readTranslationConfig(window.localStorage);
    if (!isTranslationConfigComplete(config)) return openApiConfig();
    const requestId = ++translationOperationRef.current;
    setTranslationLoading(true);
    setTranslationError('');
    try {
      const translated = await translateCues(
        clip.cues.map((cue, index) => ({ id: String(index), text: cue.text })),
        config,
      );
      if (requestId !== translationOperationRef.current) return;
      setTranslations(translated);
      window.localStorage.setItem(translationCacheKey(clip.id), JSON.stringify(translated));
    } catch (error) {
      if (requestId === translationOperationRef.current) setTranslationError(error instanceof Error ? error.message : '中文翻译失败，请稍后重试。');
    } finally {
      if (requestId === translationOperationRef.current) setTranslationLoading(false);
    }
  };
  const toggleTranslation = () => {
    if (!canOfferChineseTranslation) return;
    if (translationEnabled) {
      setTranslationEnabled(false);
      return;
    }
    if (!translationConfigured) {
      openApiConfig();
      return;
    }
    setTranslationEnabled(true);
    if (clip && Object.keys(translations).length < clip.cues.length) void translateCurrentClip();
  };
  const saveApiConfig = () => {
    const apiUrl = apiUrlDraft.trim();
    const apiKey = apiKeyDraft.trim();
    const model = modelDraft.trim();
    if (!apiUrl || !apiKey || !model) {
      setApiConfigError('请填写接口地址、API Key 和模型名称。');
      return;
    }
    const config = { apiUrl, apiKey, model };
    saveTranslationConfig(window.localStorage, config);
    setTranslationApiUrl(apiUrl);
    setTranslationApiKey(apiKey);
    setTranslationModel(model);
    setShowApiConfig(false);
    setTranslationEnabled(true);
    void translateCurrentClip(config);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !document.hasFocus()) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (phaseRef.current === 'recording_user') stopSentenceRecording();
        else if (phaseRef.current === 'playing_a' || phaseRef.current === 'playing_b') toggleComparisonPause();
        else if (phaseRef.current === 'idle' || phaseRef.current === 'error') startDirectSentenceRecording();
      } else if (event.key === 'ArrowLeft') { event.preventDefault(); moveSentence(-1); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); moveSentence(1); }
      else if (event.key.toLowerCase() === 'r') { event.preventDefault(); if (!isAnyRecording) resetSentencePractice(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (loadError) return <main className="loading-state error-state"><TextAlignLeft size={24} /><h1>训练数据还没准备好</h1><p>{loadError}</p></main>;
  if (!library || !author || !clip || !selectedCue) return <LoadingState />;

  const phase = sentenceState.phase;
  const isBusy = ['preparing_permission', 'playing_example', 'transitioning', 'processing_recording'].includes(phase);
  const isPlayingComparison = phase === 'playing_a' || phase === 'playing_b';
  const isLastSentence = selectedCueIndex === clip.cues.length - 1;
  const sentenceNextLabel = isLastSentence ? '完成本片' : '下一句';
  const errorCopy = sentenceState.error ? sentenceErrorCopy[sentenceState.error] : null;
  return (
    <div className="app-shell">
      <header className="topbar">
		<div className="brand"><BrandMark /><div><strong>口语跟练室</strong><span>Speaking Room</span></div></div>
        <div className="topbar-actions"><button ref={addVideoButtonRef} type="button" className="add-video-button" disabled={isAnyRecording} onClick={openAddVideo}><Plus size={16} weight="bold" /> 添加素材</button></div>
      </header>

      <main className="workspace sentence-workspace">
        <aside className="clip-sidebar">
          <div className="author-menu-heading">
            <div><h1>素材库</h1></div>
            <span className="count-badge">{String(library.authors.length).padStart(2, '0')}</span>
          </div>
          <div className="author-menu-scroll">
            <nav className="author-list" aria-label="素材库">
              {library.authors.map((item, index) => {
                const expanded = index === expandedAuthorIndex;
                const clipPanelId = `author-clips-${index}`;
                return (
                  <section key={item.id} className={expanded ? 'author-section expanded' : 'author-section'}>
                    <button
                      type="button"
                      className="author-trigger"
                      disabled={isAnyRecording}
                      onClick={() => { if (expanded) setExpandedAuthorIndex(null); else chooseAuthor(index); }}
                      aria-expanded={expanded}
                      aria-controls={clipPanelId}
                      aria-current={expanded ? 'true' : undefined}
                      ref={(element) => { authorButtonRefs.current[index] = element; }}
                    >
                      <img src={item.avatar} alt="" loading="lazy" />
                      <span className="author-trigger-copy"><strong>{item.name}</strong><small>{item.isUser ? '本机素材' : item.hasUserClips ? `${item.clips.length} 个训练片段 · 含本机素材` : `${item.clips.length} 个训练片段`}</small></span>
                      <CaretRight className="author-trigger-chevron" size={16} weight="bold" aria-hidden="true" />
                    </button>
                    {expanded && (
                      <div id={clipPanelId} className="author-clip-panel">
                        <div className="clip-list">
                          {item.clips.map((clipItem, clipItemIndex) => {
                            return (
                              <button type="button" key={clipItem.id} disabled={isAnyRecording} className={clipItemIndex === clipIndex ? 'clip-row active clip-row-title-above' : 'clip-row clip-row-title-above'} onClick={() => chooseClip(clipItemIndex)} aria-current={clipItemIndex === clipIndex ? 'true' : undefined}>
                                <span className="clip-number">{String(clipItemIndex + 1).padStart(2, '0')}</span><img className="clip-thumbnail" src={clipItem.poster} alt="" loading="lazy" />
                                <span className="clip-copy"><strong>{clipDisplayTitle(clipItem)}</strong><small><Clock size={12} /> {formatTime(clipItem.duration)}</small></span><Play size={15} weight={clipItemIndex === clipIndex ? 'fill' : 'regular'} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>
                );
              })}
            </nav>
          </div>
        </aside>

        <section className="studio-column">
          <article className="video-card source-card">
            <div className="card-bar"><div><span className="status-dot" /><strong>A 案例示范</strong></div><span>{clip.sourceTitle}{clip.authorName ? ` · ${clip.authorName}` : ''}</span></div>
            <div className="video-frame">
              <video ref={sourceVideoRef} key={clip.id} src={clip.video} poster={clip.poster} playsInline preload="metadata"
                onTimeUpdate={(event) => { setCurrentTime(event.currentTarget.currentTime); if (cueEndRef.current !== null && hasCueReachedEnd(event.currentTarget.currentTime, cueEndRef.current)) finishCuePlayback(); }}
                onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => { setIsPlaying(false); if (cueCompletionRef.current) finishCuePlayback(); }} />
              <button type="button" className="large-play" disabled={isAnyRecording} onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? <Pause size={26} weight="fill" /> : <Play size={26} weight="fill" />}</button>
            </div>
            <div className="transport">
              <button type="button" className="transport-primary" disabled={isAnyRecording} onClick={togglePlayback} aria-label={isPlaying ? '暂停' : '播放'}>{isPlaying ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}</button>
              <span className="time-readout">{formatTime(currentTime)} <i>/</i> {formatTime(clip.duration)}</span><div className="progress-track" aria-hidden="true"><span style={{ width: `${Math.min(100, currentTime / clip.duration * 100)}%` }} /></div>
            </div>
          </article>

          <article className={`video-card camera-card ${isAnyRecording ? 'recording' : ''} sentence-recorder`}>
             <div className="card-bar"><div><span className="status-dot" /><strong>B 我的录音</strong></div><div className="card-bar-tools"><div className="sentence-card-nav"><span>第 {String(selectedCueIndex + 1).padStart(2, '0')} / {String(clip.cues.length).padStart(2, '0')} 句</span><button type="button" disabled={isAnyRecording || selectedCueIndex === 0} onClick={() => moveSentence(-1)} aria-label="上一句" title="上一句"><CaretLeft size={15} /></button></div><button type="button" className={`camera-toggle ${cameraReady ? 'active' : ''}`} disabled={isAnyRecording} onClick={toggleCamera} aria-label={cameraReady ? '关闭摄像头' : '开启摄像头'} aria-pressed={cameraReady} title={cameraReady ? '关闭摄像头' : '开启摄像头'}><VideoCamera size={15} weight={cameraReady ? 'fill' : 'regular'} /><span>{cameraReady ? '已开启' : '未开启'}</span></button></div></div>
            <div className="sentence-current-copy"><span className="eyebrow">当前训练句</span><p>{selectedCue.text}</p></div>
            <div className="camera-frame">{sentenceRecordedUrl && !isAnyRecording ? (sentenceRecordedHasVideo ? <video key="sentence-recorded-video" ref={(element) => { userPlaybackRef.current = element; }} className="recorded-playback" src={sentenceRecordedUrl} controls playsInline preload="metadata" onEnded={finishSentencePlayback} /> : <div className="audio-playback"><Microphone size={24} /><span>声音录制完成</span><audio ref={(element) => { userPlaybackRef.current = element; }} src={sentenceRecordedUrl} controls preload="metadata" onEnded={finishSentencePlayback} /></div>) : <>{cameraReady && <video key="camera-preview" className="camera-preview" ref={cameraVideoRef} autoPlay muted playsInline />}{!cameraReady && <div className="camera-placeholder"><span className="camera-icon"><Microphone size={26} /></span><strong>{isAnyRecording ? '正在录音' : '麦克风准备录下这一句'}</strong><p>{isAnyRecording ? '当前只录制声音；如需画面，请先开启摄像头。' : '如需同时录制画面，可以开启摄像头。'}</p>{!isAnyRecording && <button type="button" onClick={ensureCamera}><VideoCamera size={16} /> 开启摄像头</button>}</div>}</>}</div>
            {(cameraError || errorCopy) && <div className="camera-error" role="alert">{errorCopy?.title && <strong>{errorCopy.title}</strong>}<span>{errorCopy?.body ?? cameraError}</span></div>}
             {sentenceRecordedUrl && <div className="quick-score-actions"><button type="button" className="quick-score-button" disabled={quickScoreState === 'scoring'} onClick={() => void scoreCurrentRecording()}>{quickScoreState === 'scoring' ? <><CircleNotch size={14} className="spin" /> 正在评分</> : quickScore ? '重新评分' : '快速评分'}</button><span>浏览器本地计算，不上传录音</span></div>}
            {quickScoreState === 'scoring' && <div className="quick-score-loading" role="status"><CircleNotch size={14} className="spin" /> 正在整理语气和节奏，完成后会自动显示</div>}
            {quickScoreState === 'error' && <p className="quick-score-error" role="alert">{quickScoreError}</p>}
            {quickScore && <section className="quick-score-card" aria-live="polite">
              <div className="quick-score-summary-heading">
                <div className="quick-score-heading"><div><span className="eyebrow">快速模仿分</span><strong>{quickScore.score}<small>/100</small></strong></div><span className={`quick-score-confidence ${quickScore.confidence}`}>{quickScore.confidenceLabel}</span></div>
                <button type="button" className="quick-score-detail-button" onClick={() => setShowQuickScoreDetails(true)}><TextAlignLeft size={14} /> 查看详细评分 <CaretRight size={13} /></button>
              </div>
              <div className="quick-score-grid"><div><span>语气</span><strong>{quickScore.subscores.prosody}</strong></div><div><span>节奏</span><strong>{quickScore.subscores.rhythm}</strong></div></div>
              {quickScore.quality.level !== 'good' && <div className={`quick-score-quality ${quickScore.quality.level}`}><strong>{quickScore.quality.label}</strong><span>{quickScore.quality.warnings.join('；')}</span></div>}
            </section>}
            {showQuickScoreDetails && quickScore && <QuickScoreDetailsModal quickScore={quickScore} cueText={selectedCue.text} audioUrl={clip.audio} cueStart={selectedCue.start} cueEnd={selectedCue.end} diagnosticActionState={diagnosticActionState} diagnosticActionMessage={diagnosticActionMessage} onClose={() => setShowQuickScoreDetails(false)} onCopy={() => void copyQuickScoreDiagnostic()} onSave={() => void saveCurrentRecording()} />}
            {clipCompletion && <p className="clip-complete" role="status"><Check size={15} weight="bold" /> 本片单句训练已完成</p>}
            <div className="sentence-actions"><button type="button" className={`training-button sentence-main ${phase === 'recording_user' ? 'stop' : ''}`} disabled={isBusy || isPlayingComparison} onClick={sentenceRecordAction}>{phase === 'recording_user' ? <Stop size={16} weight="fill" /> : sentenceRecordedUrl || sentenceState.error ? <ArrowCounterClockwise size={16} /> : <Record size={16} weight="fill" />}{sentenceButtonLabel()}</button><button type="button" className="sentence-next-icon" disabled={isAnyRecording || isBusy || isPlayingComparison} onClick={() => moveSentence(1, true)} aria-label={sentenceNextLabel} title={sentenceNextLabel}>{isLastSentence ? <Check size={17} weight="bold" /> : <CaretRight size={19} />}</button></div>
          </article>
        </section>

        <aside className="teleprompter">
          <div className="teleprompter-heading"><div className="teleprompter-title"><img src={clip.poster} alt={`${clip.title} 封面`} /><div><span className="eyebrow">单句训练</span><h2>台词列表</h2></div></div><div className="teleprompter-tools">{clip.isUserMaterial && <button type="button" className="icon-button material-delete-button" onClick={() => void deleteCurrentMaterial()} aria-label="删除当前素材" title="删除当前素材"><Trash size={16} /></button>}{canOfferChineseTranslation && <><button type="button" className={`translation-toggle ${translationEnabled ? 'active' : ''}`} onClick={toggleTranslation} aria-pressed={translationEnabled} title={!translationConfigured ? '需要先填写翻译接口配置' : undefined}><Translate size={14} /> {translationEnabled ? (translationLoading ? '生成中…' : '隐藏中文') : '开启中文'}</button>{translationConfigured && <button type="button" className="icon-button translation-settings" onClick={openApiConfig} aria-label="配置翻译接口" title="配置翻译接口"><Gear size={16} /></button>}</>}<span className="sync-state"><span /> {translationError ? '翻译失败' : translationLoading ? '中文生成中' : canOfferChineseTranslation ? '字幕已同步' : '中文字幕'}</span></div></div>
          <div className="script-scroll">
            {clip.cues.map((cue, index) => {
              const completed = completedCues.has(`${author.id}:${clip.id}:${index}`);
              return <button type="button" disabled={isAnyRecording} key={`${cue.start}-${index}`} ref={index === activeCueIndex ? activeCueRef : undefined} className={index === activeCueIndex ? 'script-line active' : 'script-line'} onClick={() => { selectSentence(index); void playCaseOnly(cue); }}><span>{completed ? <Check size={12} weight="bold" /> : formatTime(cue.start)}</span><div className="script-copy"><p>{cue.text}</p>{canOfferChineseTranslation && translationEnabled && <p className="translation-line">{translations[String(index)] ?? (translationLoading ? '正在生成中文…' : '中文暂未生成')}</p>}</div></button>;
            })}
          </div>
          <footer className="teleprompter-footer"><span><TextAlignLeft size={14} /> {clip.cues.length} 句</span><span>点击台词播放 · 空格开始 · ← → 切句 · R 重录</span></footer>
        </aside>
      </main>

      {completedImportNotice && <div className="import-complete-toast" role="status"><Check size={17} weight="bold" /><span><strong>当前视频已完成</strong><small>{completedImportNotice}</small></span></div>}
      {showAddVideo && <div className={`modal-backdrop import-backdrop${isAddVideoClosing ? ' is-closing' : ''}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeAddVideo()}><section ref={importModalRef} className={`api-modal import-modal${isAddVideoClosing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="import-title"><header><div><span className="eyebrow">本地素材</span><h2 id="import-title">添加素材</h2></div><button type="button" className="icon-button" onClick={closeAddVideo} aria-label="关闭"><X size={20} /></button></header><div className="import-tabs" role="tablist" aria-label="添加方式"><button type="button" role="tab" aria-selected={importTab === 'url'} className={importTab === 'url' ? 'import-tab active' : 'import-tab'} onClick={() => { setImportTab('url'); setImportError(''); }}><LinkSimple size={15} /> 视频网址</button><button type="button" role="tab" aria-selected={importTab === 'file'} className={importTab === 'file' ? 'import-tab active' : 'import-tab'} onClick={() => { setImportTab('file'); setImportError(''); }}><FileArrowUp size={15} /> 本地文件</button></div><div className="api-modal-body import-body">{importTab === 'url' ? <form onSubmit={enqueueUrl}><p>当前仅支持YouTube、B站链接导入</p><label htmlFor="video-url">视频网址</label><input id="video-url" value={urlDraft} onChange={(event) => { setUrlDraft(event.target.value); setImportError(''); setImportQueuedNotice(''); }} placeholder="https://..." autoComplete="off" /><button type="submit" className="primary-button import-submit" disabled={importSubmitting} aria-busy={importSubmitting}><Plus size={15} weight="bold" /> {importSubmitting ? '加入中…' : '添加'}</button></form> : <><p>选择一个视频文件，工具会自动整理格式、识别字幕并生成句子列表。支持一次选择多个文件。</p><input ref={fileInputRef} type="file" accept="video/*,.mkv,.avi,.m4v,.flv,.ts" multiple hidden onChange={(event) => { if (event.target.files) void enqueueFiles(event.target.files); event.target.value = ''; }} /><button type="button" className="drop-zone" onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length) void enqueueFiles(event.dataTransfer.files); }}><UploadSimple size={28} /><strong>拖入视频文件</strong><span>或点击选择文件</span></button></>}{importQueuedNotice && <p className="import-notice" role="status">{importQueuedNotice}</p>}{!capabilities?.modelReady && <p className="import-notice" role="status">本地语音模型未检测到。视频可以加入队列，但识别前请将模型包放到 <code>models\sensevoice</code>。</p>}{importError && <p className="api-config-error import-error" role="alert">{importError}</p>}</div>{jobs.length > 0 && <div className="import-jobs"><div className="import-jobs-heading"><strong>处理队列</strong><span>{jobs.filter((job) => !['completed', 'failed', 'cancelled'].includes(job.status)).length} 个处理中</span></div>{jobs.slice(-8).reverse().map((job) => <div className={removingJobIds.has(job.id) ? 'import-job is-removing' : 'import-job'} key={job.id}><div className="import-job-heading"><strong>{job.kind === 'url' ? job.sourceUrl || '视频网址' : job.originalName || '本地视频'}</strong><span>{job.status === 'completed' ? '完成' : job.status === 'failed' ? '失败' : job.status === 'cancelled' ? '已取消' : `${job.progress}%`}</span></div><div className="job-progress"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div><p>{job.error || job.step}</p><div className="job-actions">{job.status === 'failed' && <button type="button" className="secondary-button job-action-button" onClick={() => void retryImport(job)}><ArrowCounterClockwise size={14} /> 重试</button>}{job.status === 'completed' && job.materialId && <button type="button" className="text-button" onClick={() => openImportedJob(job)}>{job.duplicateOf ? '打开已有素材' : '打开训练'}</button>}{job.status !== 'completed' && job.status !== 'cancelled' && <button type="button" className="secondary-button job-action-button" onClick={() => void cancelImport(job)}><X size={20} /> 取消</button>}</div></div>)}</div>}<footer><button type="button" className="secondary-button" onClick={waitInBackground}>后台等待</button></footer></section></div>}

      {showApiConfig && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowApiConfig(false)}><section className="api-modal" role="dialog" aria-modal="true" aria-labelledby="api-title"><header><div><span className="eyebrow">字幕翻译设置</span><h2 id="api-title">配置翻译接口</h2></div><button type="button" className="icon-button" onClick={() => setShowApiConfig(false)} aria-label="关闭"><X size={20} /></button></header><div className="api-modal-body"><p>中文只在你点击开启后生成。配置只保存在这台设备的浏览器里，不会写进训练素材。</p><label htmlFor="translation-api-url">接口地址</label><input id="translation-api-url" type="url" value={apiUrlDraft} onChange={(event) => { setApiUrlDraft(event.target.value); setApiConfigError(''); }} placeholder="填写兼容 Chat Completions 的接口地址" autoComplete="off" /><label htmlFor="translation-api-key">API Key</label><input id="translation-api-key" type="password" value={apiKeyDraft} onChange={(event) => { setApiKeyDraft(event.target.value); setApiConfigError(''); }} placeholder="粘贴你的 API Key" autoComplete="off" /><label htmlFor="translation-model">模型名称</label><input id="translation-model" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} placeholder="填写模型名称" />{apiConfigError && <p className="api-config-error" role="alert">{apiConfigError}</p>}</div><footer><button type="button" className="secondary-button" onClick={() => setShowApiConfig(false)}>取消</button><button type="button" className="primary-button" onClick={saveApiConfig}><Check size={15} weight="bold" /> 保存并生成中文</button></footer></section></div>}
    </div>
  );
}
