#!/usr/bin/env python3
"""Build and validate the local speaking-practice dataset.

The pipeline is intentionally resumable. Source videos are read-only, while
derived audio, transcripts, plans and rendered clips live inside this app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


APP_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = APP_DIR.parents[1]
SOURCE_ROOT = REPO_DIR / "apps" / "media-crawler" / "data" / "bili"
SOURCE_VIDEO_ROOT = SOURCE_ROOT / "videos"
SOURCE_METADATA = SOURCE_ROOT / "json" / "creator_contents_2026-08-21.json"
SELECTION_FILE = APP_DIR / "data" / "source-selection.json"
WORK_DIR = APP_DIR / "work"
SOURCE_WORK_DIR = WORK_DIR / "sources"
PUBLIC_DIR = APP_DIR / "public"
MEDIA_DIR = PUBLIC_DIR / "media"
DATA_DIR = PUBLIC_DIR / "data"
LIBRARY_FILE = DATA_DIR / "library.json"
PLAN_FILE = WORK_DIR / "clip-plan.json"
AUDIT_FILE = WORK_DIR / "source-audit.json"
SENSEVOICE_MODEL = REPO_DIR / "apps" / "sensevoice" / "model.py"

MIN_DURATION = 30.0
PREFERRED_MIN = 38.0
IDEAL_DURATION = 58.0
PREFERRED_MAX = 82.0
MAX_DURATION = 96.0
MAX_INTERNAL_GAP = 3.2
MIN_SPEECH_COVERAGE = 0.72
MIN_DOMINANT_SPEAKER = 0.88

SKIP_PHRASES = (
    "一键三连",
    "点赞关注",
    "关注我们",
    "关注我",
    "投币收藏",
    "感谢观看",
    "下期视频",
    "评论区抽奖",
    "本期视频由",
    "商务合作",
)


def run(command: list[str], *, capture: bool = False) -> str:
    result = subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def serializable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(item) for item in value]
    if hasattr(value, "item"):
        return value.item()
    return value


def ffprobe(path: Path) -> dict[str, Any]:
    payload = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    return json.loads(payload)


def selected_authors() -> list[dict[str, Any]]:
    return load_json(SELECTION_FILE)["authors"]


def selected_source_ids() -> list[str]:
    return [source_id for author in selected_authors() for source_id in author["sourceIds"]]


def metadata_by_id() -> dict[str, dict[str, Any]]:
    return {str(item["video_id"]): item for item in load_json(SOURCE_METADATA)}


def source_video(source_id: str) -> Path:
    return SOURCE_VIDEO_ROOT / source_id / "video.mp4"


def format_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def clean_text(text: str) -> str:
    text = re.sub(r"<\|[^|]+\|>", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


def join_asr_tokens(tokens: Iterable[str]) -> str:
    """Join SentencePiece-like ASR pieces into readable English text."""
    output = ""
    no_space_before = set(",.!?;:%)]}，。！？；：％）】》”’")
    no_space_after = set("([{（【《“‘")
    no_space_tokens = {"'", "’", "-", "–", "/"}
    for raw_token in tokens:
        token = str(raw_token or "")
        has_word_boundary = token.startswith("▁")
        token = token.replace("▁", "")
        if not token:
            continue
        if not output:
            output = token
            continue
        previous = output[-1]
        decimal_continuation = previous == "." and bool(
            re.search(r"[0-9〇零一二三四五六七八九十百千万亿两]\.\s*$", output)
        ) and token[0].isdigit()
        needs_space = (
            (has_word_boundary and not decimal_continuation)
            or (previous in ".!?;,:，；：" and token[0].isalnum() and not decimal_continuation)
        )
        if token[0] in no_space_before or token in no_space_tokens:
            needs_space = False
        if previous in no_space_after or previous in no_space_tokens:
            needs_space = False
        output += (" " if needs_space else "") + token
    return clean_text(output)


def write_srt(path: Path, cues: Iterable[dict[str, Any]], *, offset: float = 0.0) -> None:
    lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        start = max(0.0, float(cue["start"]) - offset)
        end = max(start + 0.05, float(cue["end"]) - offset)
        lines.extend(
            [
                str(index),
                f"{format_timestamp(start)} --> {format_timestamp(end)}",
                clean_text(str(cue["text"])),
                "",
            ]
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def audit_sources() -> list[dict[str, Any]]:
    metadata = metadata_by_id()
    author_by_source = {
        source_id: author for author in selected_authors() for source_id in author["sourceIds"]
    }
    audit: list[dict[str, Any]] = []
    for source_id in selected_source_ids():
        path = source_video(source_id)
        if not path.exists():
            raise FileNotFoundError(f"Missing selected source video: {path}")
        probe = ffprobe(path)
        streams = probe.get("streams", [])
        video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
        audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
        if not video_stream or not audio_stream:
            raise RuntimeError(f"Source {source_id} is missing a video or audio stream")
        item = metadata[source_id]
        author = author_by_source[source_id]
        audit.append(
            {
                "sourceId": source_id,
                "authorId": author["id"],
                "authorName": author["name"],
                "title": item["title"],
                "sourceUrl": item["video_url"],
                "path": str(path.relative_to(REPO_DIR)),
                "duration": round(float(probe["format"]["duration"]), 3),
                "bytes": int(probe["format"]["size"]),
                "videoCodec": video_stream.get("codec_name"),
                "audioCodec": audio_stream.get("codec_name"),
                "width": int(video_stream.get("width", 0)),
                "height": int(video_stream.get("height", 0)),
                "mtimeNs": path.stat().st_mtime_ns,
            }
        )
    write_json(AUDIT_FILE, audit)
    total_minutes = sum(item["duration"] for item in audit) / 60
    total_gib = sum(item["bytes"] for item in audit) / (1024**3)
    print(f"Audited {len(audit)} selected sources, {total_minutes:.1f} min, {total_gib:.2f} GiB")
    return audit


def extract_audio(source_id: str) -> Path:
    output_dir = SOURCE_WORK_DIR / source_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "audio.mp3"
    if output.exists() and output.stat().st_size > 0:
        return output
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source_video(source_id)),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-b:a",
            "128k",
            "-map_metadata",
            "-1",
            str(output),
        ]
    )
    return output


def _enable_unicode_sentencepiece_paths() -> None:
    """Load local SentencePiece files when the portable folder has Chinese text."""
    from funasr.tokenizer.sentencepiece_tokenizer import SentencepiecesTokenizer
    import sentencepiece as spm

    if getattr(SentencepiecesTokenizer, "_speaking_unicode_path_patch", False):
        return

    def build_sentence_piece_processor(self: Any) -> None:
        if self.sp is None:
            self.sp = spm.SentencePieceProcessor()
            if any(ord(character) > 127 for character in self.bpemodel):
                self.sp.LoadFromSerializedProto(Path(self.bpemodel).read_bytes())
            else:
                self.sp.load(self.bpemodel)

    SentencepiecesTokenizer._build_sentence_piece_processor = build_sentence_piece_processor
    SentencepiecesTokenizer._speaking_unicode_path_patch = True


class LocalTranscriber:
    def __init__(self, device: str) -> None:
        _enable_unicode_sentencepiece_paths()
        from funasr import AutoModel

        print(f"Loading SenseVoiceSmall pipeline on {device}...")
        model_reference = os.environ.get("SPEAKING_PRACTICE_SENSEVOICE_MODEL", "iic/SenseVoiceSmall")
        remote_code = os.environ.get("SPEAKING_PRACTICE_SENSEVOICE_REMOTE_CODE", str(SENSEVOICE_MODEL))

        dependency_root = Path(model_reference) / "dependencies"

        def dependency_model(name: str, environment_name: str, fallback: str) -> str:
            configured = os.environ.get(environment_name, "").strip()
            if configured:
                return configured
            local_path = dependency_root / name
            return str(local_path) if local_path.is_dir() else fallback

        self.model = AutoModel(
            model=model_reference,
            trust_remote_code=True,
            remote_code=remote_code,
            vad_model=dependency_model("fsmn-vad", "SPEAKING_PRACTICE_VAD_MODEL", "fsmn-vad"),
            vad_kwargs={"max_single_segment_time": 30000},
            spk_model=dependency_model("cam++", "SPEAKING_PRACTICE_SPK_MODEL", "cam++"),
            spk_mode="vad_segment",
            punc_model=dependency_model("ct-punc", "SPEAKING_PRACTICE_PUNC_MODEL", "ct-punc"),
            device=device,
            disable_update=True,
        )

    def transcribe(self, audio_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        result = self.model.generate(
            input=str(audio_path),
            cache={},
            language="auto",
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
            sentence_timestamp=True,
        )
        if not result:
            raise RuntimeError(f"No transcription result for {audio_path}")
        raw = serializable(result[0])
        cues = self._word_timestamp_cues(raw)
        if not cues:
            raise RuntimeError(f"No usable word timestamps for {audio_path}")
        return raw, cues

    @staticmethod
    def _word_timestamp_cues(raw: dict[str, Any]) -> list[dict[str, Any]]:
        """Turn SenseVoice word timestamps into natural teleprompter-sized cues.

        FunASR's sentence merger can collapse long SenseVoice results into one
        sentence. The model still returns aligned word/timestamp pairs, so use
        those as the source of truth and only use VAD sentences for speaker
        attribution.
        """
        words = raw.get("words") or []
        timestamps = raw.get("timestamp") or []
        if len(words) != len(timestamps):
            return []

        speaker_segments: list[dict[str, Any]] = []
        for sentence in raw.get("sentence_info") or []:
            start = float(sentence.get("start", 0))
            end = float(sentence.get("end", 0))
            if end > start:
                speaker_segments.append(
                    {"start": start, "end": end, "speaker": sentence.get("spk")}
                )

        def speaker_for(start_ms: float, end_ms: float) -> Any:
            best_speaker = None
            best_overlap = 0.0
            for segment in speaker_segments:
                overlap = max(
                    0.0,
                    min(end_ms, segment["end"]) - max(start_ms, segment["start"]),
                )
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = segment["speaker"]
            return best_speaker

        cue_groups: list[list[tuple[str, float, float]]] = []
        current: list[tuple[str, float, float]] = []
        sentence_end = re.compile(r"[.!?。！？]+$")
        soft_end = re.compile(r"[，,；;：:]+$")

        def flush() -> None:
            nonlocal current
            if current:
                cue_groups.append(current)
                current = []

        def is_numeric_piece(value: str) -> bool:
            visible = value.replace("▁", "").strip()
            return bool(re.fullmatch(r"[0-9]+", visible) or re.fullmatch(r"[〇零一二三四五六七八九十百千万亿两]+", visible))

        def is_decimal_point(index: int, visible_token: str) -> bool:
            if visible_token not in {".", "．"} or len(current) < 2:
                return False
            previous = current[-2][0]
            next_visible = ""
            for following in words[index + 1 :]:
                candidate = str(following or "").replace("▁", "").strip()
                if candidate:
                    next_visible = candidate
                    break
            return is_numeric_piece(previous) and is_numeric_piece(next_visible)

        def next_is_subword_continuation(index: int) -> bool:
            for following in words[index + 1 :]:
                candidate = str(following or "").replace("▁", "").strip()
                if not candidate:
                    continue
                return not str(following).startswith("▁") and bool(re.match(r"[A-Za-z0-9〇零一二三四五六七八九十百千万亿两]", candidate))
            return False

        short_function_words = {
            "i", "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "but", "so",
            "we", "you", "he", "she", "it", "they", "this", "that", "is", "are", "was", "were", "be",
            "am", "can", "could", "will", "would", "should", "may", "might", "must",
            "do", "does", "did", "have", "has", "had",
        }

        def current_ends_with_short_function_word() -> bool:
            if not current:
                return False
            visible = current[-1][0].replace("▁", "").strip().casefold()
            return visible in short_function_words

        for index, (word, timestamp) in enumerate(zip(words, timestamps)):
            if not isinstance(timestamp, (list, tuple)) or len(timestamp) < 2:
                continue
            token = str(word or "")
            start_ms = float(timestamp[0])
            end_ms = float(timestamp[1])
            if not token.replace("▁", "").strip() or end_ms <= start_ms:
                continue
            if current and start_ms - current[-1][2] > 1600:
                flush()
            # Keep SentencePiece fragments together. A hard cap is allowed to
            # end a cue before the next complete word, but never between
            # pieces such as "H" + "ello" or "N" + "eil".
            projected_duration_ms = end_ms - current[0][1] if current else 0
            if (
                current
                and token.startswith("▁")
                and projected_duration_ms >= 11000
                and not next_is_subword_continuation(index)
                and not current_ends_with_short_function_word()
            ):
                flush()
            current.append((token, start_ms, end_ms))
            duration_ms = end_ms - current[0][1]
            visible_token = token.replace("▁", "").strip()
            if sentence_end.search(visible_token) and not is_decimal_point(index, visible_token):
                flush()
            elif duration_ms >= 6500 and soft_end.search(visible_token):
                flush()
        flush()

        def word_entries(group: list[tuple[str, float, float]]) -> list[dict[str, Any]]:
            """Return visible words together with their token boundaries."""
            entries: list[dict[str, Any]] = []
            current: dict[str, Any] | None = None
            for token_index, (token, _, _) in enumerate(group):
                visible = token.replace("▁", "").strip()
                if not visible:
                    continue
                if current is None or token.startswith("▁"):
                    if current is not None:
                        current["end_index"] = token_index
                        entries.append(current)
                    current = {"text": visible, "start_index": token_index}
                else:
                    current["text"] += visible
            if current is not None:
                current["end_index"] = len(group)
                entries.append(current)
            return entries

        def split_inferred_boundaries(
            group: list[tuple[str, float, float]],
        ) -> list[tuple[list[tuple[str, float, float]], bool]]:
            """Split two high-confidence transcript boundary artifacts.

            SenseVoice occasionally returns ``bustling bustling means`` where
            the second ``bustling`` starts a definition, and can emit the
            beginning of ``Speaking of what do you...`` in a preceding VAD
            chunk. These are safe local repairs because both boundaries are
            identified from the surrounding words, not guessed from timing.
            """
            entries = word_entries(group)
            split_at: int | None = None
            add_terminal_to_prefix = False
            for entry_index, entry in enumerate(entries):
                compact = entry["text"].casefold().replace("’", "'")
                following = entries[entry_index + 1 : entry_index + 5]
                following_text = "".join(item["text"] for item in following).casefold().replace("’", "'")
                if (
                    compact == "bustling"
                    and entry_index > 0
                    and entries[entry_index - 1]["text"].casefold() == "bustling"
                    and following_text.startswith("means")
                ):
                    split_at = int(entry["start_index"])
                    add_terminal_to_prefix = True
                    break
                if compact in {"spking", "speaking"} and entry_index > 0:
                    if following_text.startswith("ofwhatdoyou"):
                        split_at = int(entry["start_index"])
                        break
            if split_at is None or split_at <= 0 or split_at >= len(group):
                return [(group, False)]
            return [(group[:split_at], add_terminal_to_prefix), *split_inferred_boundaries(group[split_at:])]

        expanded_groups: list[tuple[list[tuple[str, float, float]], bool]] = []
        for group in cue_groups:
            expanded_groups.extend(split_inferred_boundaries(group))

        cues: list[dict[str, Any]] = []
        for group, add_terminal_to_prefix in expanded_groups:
            text = join_asr_tokens(token for token, _, _ in group)
            text = re.sub(r"\bspking\b", "Speaking", text, flags=re.IGNORECASE)
            if add_terminal_to_prefix and text and not sentence_end.search(text):
                text += "."
            start_ms = group[0][1]
            end_ms = group[-1][2]
            if not text or end_ms <= start_ms:
                continue
            cues.append(
                {
                    "start": round(start_ms / 1000, 3),
                    "end": round(end_ms / 1000, 3),
                    "text": text,
                    "speaker": speaker_for(start_ms, end_ms),
                }
            )
        return LocalTranscriber.merge_cue_boundaries(cues)

    @staticmethod
    def normalize_local_transcript_text(text: str) -> str:
        """Apply only high-confidence, offline transcript normalizations."""
        text = re.sub(r"\blearning(?:arning)?eng(?:ng)?lish\b", "learningenglish", text, flags=re.IGNORECASE)
        text = re.sub(r"\blearningenglish\b", "Learning English", text, flags=re.IGNORECASE)
        text = re.sub(r"\bwebsitebblearningenglish\b", "website BBC Learning English", text, flags=re.IGNORECASE)
        text = re.sub(r"\bspking\b", "Speaking", text, flags=re.IGNORECASE)
        text = re.sub(r"\bcap\s+cities\b", "capital cities", text, flags=re.IGNORECASE)
        text = re.sub(r"\bTbili\b", "Tbilisi", text, flags=re.IGNORECASE)
        text = re.sub(r"\bIve\b", "I've", text)
        text = re.sub(r"\bGoode\b", "Good", text)
        text = re.sub(r"([A-Za-z])'cause\b", r"\1 'cause", text)
        text = re.sub(r"\bhas\.\s+Beautiful\b", "has beautiful", text, flags=re.IGNORECASE)
        text = re.sub(r"\bto\.\s+(Georgia|Latin America)\b", r"to \1", text, flags=re.IGNORECASE)
        text = re.sub(r"(\bbustling\s+means\b.*)\s+busy$", r"\1", text, flags=re.IGNORECASE)
        text = re.sub(r"(\bbustling\s+means\b.*\bgoing\s+on)$", r"\1.", text, flags=re.IGNORECASE)
        text = re.sub(
            r"(Speaking\s+of\s+what\s+do\s+you\s+like\s+about\s+living\s+in\s+a\s+big\s+bustling\s+city)\.$",
            r"\1?",
            text,
            flags=re.IGNORECASE,
        )
        text = re.sub(r"\blive\s+in\s+Oh,", "live in? Oh,", text, flags=re.IGNORECASE)
        return text

    @staticmethod
    def merge_cue_boundaries(cues: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Repair safe cross-cue boundaries without changing audio alignment.

        The ASR model may flush on an uncertain period, at a VAD speaker
        boundary, or after a soft comma. This pass joins only close, strongly
        indicated continuations and removes one repeated overlap word.
        """
        word_pattern = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?|[0-9]+(?:\.[0-9]+)?")
        terminal = re.compile(r"[.!?。！？]+$")
        soft_terminal = re.compile(r"[,，;；:：]+$")
        domain_prefix_pattern = re.compile(r"^(com|org|net|co|cn|io|ai|tv)\b\s*(.*)$", flags=re.IGNORECASE)
        domain_hints = ("website", "www", "http", "learningenglish", "bblearningenglish")
        weak_end_words = {
            "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "but",
            "because", "which", "that", "is", "are", "was", "were", "be", "can",
            "could", "will", "would", "should", "may", "might", "must", "do", "does",
            "did", "has", "had", "there's", "it's", "what's", "who's",
        }
        cross_speaker_weak_end_words = {"to", "of", "a", "an", "the", "which", "because"}
        unfinished_tail_words = {
            "get", "find", "see", "watch", "listen", "go", "talk", "like", "live", "work",
            "pay", "want", "need", "make", "tell", "start", "leave", "put", "take", "give",
        }
        continuation_starters = {"and", "but", "because", "which", "so", "or", "with", "as", "then"}

        def words(text: str) -> list[str]:
            return word_pattern.findall(text)

        def compatible_speakers(left: Any, right: Any) -> bool:
            return left is None or right is None or left == right

        def has_domain_hint(text: str) -> bool:
            compact = re.sub(r"\s+", "", text).casefold()
            return any(hint in compact for hint in domain_hints)

        def merge_text(left: str, right: str, *, remove_overlap: bool, strip_terminal: bool) -> str:
            left = left.rstrip()
            right = right.lstrip()
            if strip_terminal:
                left = re.sub(r"[.!?。！？]+$", "", left).rstrip()
            if re.search(r"\bplays\s+there's\.?$", left, flags=re.IGNORECASE) and re.match(r"^A\s+really\b", right):
                left = re.sub(r"\bplays\s+there's\.?$", "plays. There's", left, flags=re.IGNORECASE)
                right = re.sub(r"^A\b", "a", right, count=1)
            if strip_terminal and re.search(r"\bhas$", left, flags=re.IGNORECASE):
                right = re.sub(r"^([A-Z])", lambda match: match.group(1).lower(), right, count=1)
            if remove_overlap:
                match = re.match(r"^([A-Za-z]+(?:['’][A-Za-z]+)?)(.*)$", right, flags=re.IGNORECASE)
                if match:
                    right = match.group(2).lstrip()
            if not right:
                return left
            if not left:
                return right
            if right[0] in ",，.!?。！？;；:：)]}":
                return f"{left}{right}"
            return f"{left} {right}"

        def try_merge(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any] | None:
            try:
                gap = float(right["start"]) - float(left["end"])
                duration = float(right["end"]) - float(left["start"])
            except (KeyError, TypeError, ValueError):
                return None
            if gap < -0.05 or gap > 0.75 or duration > 14.5:
                return None
            left_words = words(str(left.get("text", "")))
            right_words = words(str(right.get("text", "")))
            if not left_words or not right_words:
                return None
            left_last = left_words[-1].casefold().replace("’", "'")
            right_first = right_words[0].casefold().replace("’", "'")
            left_text = str(left.get("text", "")).rstrip()
            right_text = str(right.get("text", "")).lstrip()
            has_terminal = bool(terminal.search(left_text))
            has_soft_terminal = bool(soft_terminal.search(left_text))
            next_starts_lowercase = bool(re.match(r"[a-z]", right_text))
            same_speaker = compatible_speakers(left.get("speaker"), right.get("speaker"))
            left_duration = float(left["end"]) - float(left["start"])
            definition_repeat = (
                left_last == "bustling"
                and right_first == "bustling"
                and bool(re.match(r"bustling\s+means\b", right_text, flags=re.IGNORECASE))
            )
            duplicate_overlap = gap <= 0.45 and left_last == right_first and not definition_repeat
            question_scaffold = bool(
                re.search(
                    r"\b(?:what|where|how|why|when|who|which)\s+"
                    r"(?:do|does|did|are|is|can|could|would|will)\s+you$",
                    re.sub(r"[.!?。！？]+$", "", left_text, flags=re.IGNORECASE).casefold(),
                )
            )
            weak_continuation = (
                has_terminal
                and left_last in weak_end_words
                and (same_speaker or left_last in cross_speaker_weak_end_words)
                and (
                    next_starts_lowercase
                    or (
                        left_last in {"to", "has", "of", "which", "because", "there's", "it's", "what's", "who's"}
                        and right_first != "what"
                    )
                )
            )
            isolated_noise = (
                len(left_words) == 1
                and left_last in {"the", "a", "an"}
                and left_duration >= 1.5
            )
            if isolated_noise:
                weak_continuation = False
            unfinished_continuation = (
                not has_terminal
                and next_starts_lowercase
                and (left_last in unfinished_tail_words or right_first in continuation_starters)
                and (same_speaker or next_starts_lowercase)
            )
            soft_continuation = has_soft_terminal and same_speaker
            lowercase_continuation = (
                has_terminal
                and next_starts_lowercase
                and right_first in {"and", "but", "because", "which", "so", "or", "with", "as", "then", "talking"}
                and same_speaker
            )
            if not any(
                (duplicate_overlap, question_scaffold and gap <= 0.75, weak_continuation,
                 unfinished_continuation, soft_continuation, lowercase_continuation)
            ):
                return None
            merged = dict(left)
            if lowercase_continuation and left_text.endswith("."):
                left_text = f"{left_text[:-1]},"
            strip_weak_terminal = weak_continuation and (
                left_last == "has" or (left_last == "to" and right_first not in {"what", "for"})
            )
            merged["text"] = merge_text(
                left_text,
                right_text,
                remove_overlap=duplicate_overlap,
                strip_terminal=duplicate_overlap or question_scaffold or strip_weak_terminal,
            )
            merged["end"] = right["end"]
            return merged

        def split_known_sentence_boundary(left: dict[str, Any], right: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
            """Keep a high-confidence sentence boundary that VAD joined awkwardly."""
            left_text = str(left.get("text", "")).rstrip()
            right_text = str(right.get("text", "")).lstrip()
            if not re.search(r"\bplays\s+there's\.?$", left_text, flags=re.IGNORECASE):
                return None
            if not re.match(r"^A\s+really\b", right_text, flags=re.IGNORECASE):
                return None
            left_split = dict(left)
            right_split = dict(right)
            left_split["text"] = re.sub(r"\bplays\s+there's\.?$", "plays.", left_text, flags=re.IGNORECASE)
            right_split["text"] = re.sub(r"^A\s+really\b", "There's a really", right_text, count=1, flags=re.IGNORECASE)
            return left_split, right_split

        repaired: list[dict[str, Any]] = []
        for cue in cues:
            current = dict(cue)
            current["text"] = LocalTranscriber.normalize_local_transcript_text(str(current.get("text", "")))
            if repaired:
                domain_prefix = domain_prefix_pattern.match(current["text"])
                if domain_prefix:
                    try:
                        close_enough = float(current["start"]) - float(repaired[-1]["end"]) <= 0.75
                    except (KeyError, TypeError, ValueError):
                        close_enough = False
                    if close_enough and has_domain_hint(str(repaired[-1].get("text", ""))):
                        suffix = domain_prefix.group(1).casefold()
                        remainder = domain_prefix.group(2).strip()
                        previous_text = re.sub(r"[.!?。！？,，;；:：]+$", "", str(repaired[-1]["text"]).rstrip())
                        repaired[-1]["text"] = f"{previous_text}.{suffix}."
                        if remainder:
                            repaired[-1]["text"] += f" {remainder}"
                        repaired[-1]["end"] = current["end"]
                        continue
                split = split_known_sentence_boundary(repaired[-1], current)
                if split is not None:
                    repaired[-1], current = split
                    repaired.append(current)
                    continue
                merged = try_merge(repaired[-1], current)
                if merged is not None:
                    repaired[-1] = merged
                    continue
            repaired.append(current)
        for cue in repaired:
            text = str(cue.get("text", ""))
            if text and re.match(r"[a-z]", text):
                cue["text"] = text[0].upper() + text[1:]
        return repaired


def transcribe_sources(device: str, source_filter: str | None = None, limit: int = 0) -> None:
    source_ids = selected_source_ids()
    if source_filter:
        if source_filter not in source_ids:
            raise ValueError(f"Unknown selected source id: {source_filter}")
        source_ids = [source_filter]
    if limit:
        source_ids = source_ids[:limit]

    pending = [
        source_id
        for source_id in source_ids
        if not (SOURCE_WORK_DIR / source_id / "cues.json").exists()
    ]
    if not pending:
        print("All requested sources already have cached transcripts")
        return

    transcriber = LocalTranscriber(device)
    for index, source_id in enumerate(pending, start=1):
        print(f"[{index}/{len(pending)}] Extracting and transcribing {source_id}")
        audio = extract_audio(source_id)
        raw, cues = transcriber.transcribe(audio)
        output_dir = SOURCE_WORK_DIR / source_id
        write_json(output_dir / "transcription.json", raw)
        write_json(output_dir / "cues.json", cues)
        write_srt(output_dir / "transcript.srt", cues)
        print(
            f"  {len(cues)} cues, {cues[0]['start']:.1f}s to {cues[-1]['end']:.1f}s, "
            f"speakers={sorted({str(cue['speaker']) for cue in cues})}"
        )


def candidate_windows(cues: list[dict[str, Any]], source_duration: float) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for start_index in range(len(cues)):
        if cues[start_index]["start"] < 12:
            continue
        speech_duration = 0.0
        speaker_duration: Counter[str] = Counter()
        max_gap = 0.0
        for end_index in range(start_index, min(len(cues), start_index + 14)):
            cue = cues[end_index]
            speech_duration += cue["end"] - cue["start"]
            speaker_duration[str(cue.get("speaker"))] += cue["end"] - cue["start"]
            if end_index > start_index:
                max_gap = max(max_gap, cue["start"] - cues[end_index - 1]["end"])
            start = cues[start_index]["start"]
            end = cue["end"]
            duration = end - start
            if duration < MIN_DURATION:
                continue
            if duration > MAX_DURATION:
                break
            if end > source_duration - 15:
                continue
            text = "".join(item["text"] for item in cues[start_index : end_index + 1])
            if any(phrase in text for phrase in SKIP_PHRASES):
                continue
            coverage = speech_duration / duration
            dominant_speaker, dominant_seconds = speaker_duration.most_common(1)[0]
            speaker_ratio = dominant_seconds / speech_duration if speech_duration else 0
            if coverage < MIN_SPEECH_COVERAGE or speaker_ratio < MIN_DOMINANT_SPEAKER:
                continue
            if max_gap > MAX_INTERNAL_GAP:
                continue
            ends_cleanly = bool(re.search(r"[。！？?!]$", text))
            awkward_start = bool(
                re.match(
                    r"^(然后|但是|可是|而且|因为|所以|除此之外|再远一点|一会儿|好那|那第二|那第三|这时候|这个时候)",
                    text,
                )
            )
            starts_cleanly = not awkward_start
            duration_score = max(0.0, 1.0 - abs(duration - IDEAL_DURATION) / 50)
            preferred_bonus = 0.15 if PREFERRED_MIN <= duration <= PREFERRED_MAX else 0
            score = (
                duration_score * 0.3
                + coverage * 0.25
                + speaker_ratio * 0.25
                + (0.1 if ends_cleanly else 0)
                + (0.08 if starts_cleanly else -0.18)
                + preferred_bonus
            )
            candidates.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "duration": round(duration, 3),
                    "cueStart": start_index,
                    "cueEnd": end_index,
                    "text": text,
                    "dominantSpeaker": dominant_speaker,
                    "speakerRatio": round(speaker_ratio, 4),
                    "speechCoverage": round(coverage, 4),
                    "maxInternalGap": round(max_gap, 3),
                    "semanticEnd": ends_cleanly,
                    "score": round(score, 5),
                }
            )
    return sorted(candidates, key=lambda item: item["score"], reverse=True)


def overlaps(left: dict[str, Any], right: dict[str, Any], padding: float = 8.0) -> bool:
    return not (left["end"] + padding <= right["start"] or right["end"] + padding <= left["start"])


def select_non_overlapping(candidates: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for candidate in candidates:
        if any(overlaps(candidate, existing) for existing in selected):
            continue
        selected.append(candidate)
        if len(selected) == count:
            break
    return sorted(selected, key=lambda item: item["start"])


def plan_clips() -> dict[str, Any]:
    if not AUDIT_FILE.exists():
        audit_sources()
    audit = {item["sourceId"]: item for item in load_json(AUDIT_FILE)}
    metadata = metadata_by_id()
    plan_authors: list[dict[str, Any]] = []
    for author in selected_authors():
        source_ids = author["sourceIds"]
        base_per_source = author["targetClips"] // len(source_ids)
        remainder = author["targetClips"] % len(source_ids)
        selected_for_author: list[dict[str, Any]] = []
        unused_by_source: dict[str, list[dict[str, Any]]] = {}
        for source_index, source_id in enumerate(source_ids):
            cues_file = SOURCE_WORK_DIR / source_id / "cues.json"
            if not cues_file.exists():
                raise FileNotFoundError(f"Missing transcript cues: {cues_file}")
            cues = load_json(cues_file)
            candidates = candidate_windows(cues, audit[source_id]["duration"])
            requested = base_per_source + (1 if source_index < remainder else 0)
            chosen = select_non_overlapping(candidates, requested)
            unused_by_source[source_id] = [item for item in candidates if item not in chosen]
            for candidate in chosen:
                candidate["sourceId"] = source_id
                selected_for_author.append(candidate)

        while len(selected_for_author) < author["targetClips"]:
            pool = sorted(
                (
                    dict(candidate, sourceId=source_id)
                    for source_id, candidates in unused_by_source.items()
                    for candidate in candidates
                ),
                key=lambda item: item["score"],
                reverse=True,
            )
            next_candidate = next(
                (
                    candidate
                    for candidate in pool
                    if not any(
                        candidate["sourceId"] == existing["sourceId"]
                        and overlaps(candidate, existing)
                        for existing in selected_for_author
                    )
                ),
                None,
            )
            if next_candidate is None:
                break
            selected_for_author.append(next_candidate)
            unused_by_source[next_candidate["sourceId"]].remove(
                {key: value for key, value in next_candidate.items() if key != "sourceId"}
            )

        if len(selected_for_author) != author["targetClips"]:
            raise RuntimeError(
                f"Could only find {len(selected_for_author)}/{author['targetClips']} clips for {author['name']}"
            )

        clips: list[dict[str, Any]] = []
        for clip_index, candidate in enumerate(
            sorted(selected_for_author, key=lambda item: (source_ids.index(item["sourceId"]), item["start"])),
            start=1,
        ):
            source_id = candidate["sourceId"]
            clip_id = f"{author['id']}-{clip_index:02d}"
            title_text = clean_text(candidate["text"])
            clip_title = title_text[:26] + ("..." if len(title_text) > 26 else "")
            clips.append(
                {
                    "id": clip_id,
                    "authorId": author["id"],
                    "authorName": author["name"],
                    "title": clip_title,
                    "sourceId": source_id,
                    "sourceTitle": metadata[source_id]["title"],
                    "sourceUrl": metadata[source_id]["video_url"],
                    **candidate,
                }
            )
        plan_authors.append({**author, "clips": clips})

    plan = {
        "version": 1,
        "model": "FunASR 1.4.3 + SenseVoiceSmall + FSMN-VAD + CAM++ + CT-Punc",
        "authors": plan_authors,
    }
    write_json(PLAN_FILE, plan)
    print(f"Planned {sum(len(author['clips']) for author in plan_authors)} clips")
    return plan


def render_clip(clip: dict[str, Any]) -> dict[str, Any]:
    output_dir = MEDIA_DIR / clip["authorId"] / clip["id"]
    output_dir.mkdir(parents=True, exist_ok=True)
    video_path = output_dir / "video.mp4"
    audio_path = output_dir / "audio.mp3"
    subtitle_path = output_dir / "transcript.srt"
    poster_path = output_dir / "poster.jpg"
    duration = float(clip["duration"])
    start = float(clip["start"])

    if not video_path.exists():
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source_video(clip["sourceId"])),
                "-t",
                f"{duration:.3f}",
                "-vf",
                "scale='min(1280,iw)':-2",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "21",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                str(video_path),
            ]
        )
    if not audio_path.exists():
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source_video(clip["sourceId"])),
                "-t",
                f"{duration:.3f}",
                "-vn",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-b:a",
                "128k",
                "-map_metadata",
                "-1",
                str(audio_path),
            ]
        )
    if not poster_path.exists():
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{start + duration / 2:.3f}",
                "-i",
                str(source_video(clip["sourceId"])),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(960,iw)':-2",
                "-q:v",
                "3",
                str(poster_path),
            ]
        )
    cues = load_json(SOURCE_WORK_DIR / clip["sourceId"] / "cues.json")
    clip_cues = [
        cue
        for cue in cues[clip["cueStart"] : clip["cueEnd"] + 1]
        if cue["end"] > start and cue["start"] < clip["end"]
    ]
    write_srt(subtitle_path, clip_cues, offset=start)
    relative_cues = [
        {
            **cue,
            "start": round(max(0.0, cue["start"] - start), 3),
            "end": round(min(duration, cue["end"] - start), 3),
        }
        for cue in clip_cues
    ]
    relative_base = f"/media/{clip['authorId']}/{clip['id']}"
    return {
        **{key: value for key, value in clip.items() if key not in {"cueStart", "cueEnd"}},
        "video": f"{relative_base}/video.mp4",
        "audio": f"{relative_base}/audio.mp3",
        "subtitle": f"{relative_base}/transcript.srt",
        "poster": f"{relative_base}/poster.jpg",
        "cues": relative_cues,
    }


def render_dataset() -> dict[str, Any]:
    plan = load_json(PLAN_FILE) if PLAN_FILE.exists() else plan_clips()
    library_authors: list[dict[str, Any]] = []
    for author in plan["authors"]:
        rendered = []
        for index, clip in enumerate(author["clips"], start=1):
            print(f"Rendering {author['name']} {index}/{len(author['clips'])}: {clip['id']}")
            rendered.append(render_clip(clip))
        library_authors.append(
            {
                "id": author["id"],
                "name": author["name"],
                "bilibiliMid": author["bilibiliMid"],
                "avatar": f"/avatars/{author['id']}.jpg",
                "clips": rendered,
            }
        )
    library = {
        "version": 1,
        "clipCount": sum(len(author["clips"]) for author in library_authors),
        "model": plan["model"],
        "authors": library_authors,
    }
    write_json(LIBRARY_FILE, library)
    print(f"Rendered dataset with {library['clipCount']} clips")
    return library


def validate_dataset(deep: bool) -> None:
    errors: list[str] = []
    if not LIBRARY_FILE.exists():
        errors.append(f"Missing {LIBRARY_FILE}")
    else:
        library = load_json(LIBRARY_FILE)
        if library.get("clipCount") != 32:
            errors.append(f"Expected 32 clips, got {library.get('clipCount')}")
        if len(library.get("authors", [])) != 4:
            errors.append("Expected 4 authors")
        for author in library.get("authors", []):
            if len(author.get("clips", [])) != 8:
                errors.append(f"Expected 8 clips for {author.get('name')}")
            avatar = PUBLIC_DIR / author["avatar"].lstrip("/")
            if not avatar.exists() or avatar.stat().st_size == 0:
                errors.append(f"Missing author avatar: {avatar}")
            for clip in author.get("clips", []):
                if not (MIN_DURATION <= clip["duration"] <= MAX_DURATION):
                    errors.append(f"Duration outside allowed range: {clip['id']} {clip['duration']}")
                if clip["speakerRatio"] < MIN_DOMINANT_SPEAKER:
                    errors.append(f"Speaker ratio too low: {clip['id']}")
                if clip["speechCoverage"] < MIN_SPEECH_COVERAGE:
                    errors.append(f"Speech coverage too low: {clip['id']}")
                if not clip.get("cues"):
                    errors.append(f"Missing cues: {clip['id']}")
                for key in ("video", "audio", "subtitle", "poster"):
                    media_path = PUBLIC_DIR / clip[key].lstrip("/")
                    if not media_path.exists() or media_path.stat().st_size == 0:
                        errors.append(f"Missing {key}: {media_path}")
                if deep:
                    video_path = PUBLIC_DIR / clip["video"].lstrip("/")
                    if video_path.exists():
                        actual = float(ffprobe(video_path)["format"]["duration"])
                        if abs(actual - clip["duration"]) > 1.2:
                            errors.append(
                                f"Duration mismatch {clip['id']}: planned={clip['duration']}, actual={actual}"
                            )
        serialized = json.dumps(library, ensure_ascii=False)
        if str(REPO_DIR) in serialized:
            errors.append("Library JSON contains an absolute repository path")

    if errors:
        print("Dataset validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        raise SystemExit(1)
    print("Dataset validation passed")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("audit")
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--source-id")
    transcribe_parser = subparsers.add_parser("transcribe")
    transcribe_parser.add_argument("--device", default="mps")
    transcribe_parser.add_argument("--source-id")
    transcribe_parser.add_argument("--limit", type=int, default=0)
    subparsers.add_parser("plan")
    subparsers.add_parser("render")
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--deep", action="store_true")
    args = parser.parse_args()

    if args.command == "audit":
        audit_sources()
    elif args.command == "extract":
        ids = [args.source_id] if args.source_id else selected_source_ids()
        for index, source_id in enumerate(ids, start=1):
            print(f"[{index}/{len(ids)}] {extract_audio(source_id)}")
    elif args.command == "transcribe":
        transcribe_sources(args.device, args.source_id, args.limit)
    elif args.command == "plan":
        plan_clips()
    elif args.command == "render":
        render_dataset()
    elif args.command == "validate":
        validate_dataset(args.deep)


if __name__ == "__main__":
    main()
