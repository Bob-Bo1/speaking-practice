#!/usr/bin/env python3
"""Local service for importing videos into the speaking-practice app.

The service is intentionally local-only. It orchestrates the bundled yt-dlp,
FFmpeg and SenseVoice runtime, then stores user-owned materials next to the
application so a portable Windows bundle does not need a server or C: drive
cache.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = APP_DIR.parent
REPO_DIR = APP_DIR.parents[1]
_configured_sensevoice_dir = os.environ.get("SPEAKING_PRACTICE_SENSEVOICE_ROOT", "").strip()
_sensevoice_candidates = (APP_DIR / "sensevoice", PACKAGE_DIR / "sensevoice", APP_DIR.parent / "sensevoice")
SENSEVOICE_DIR = Path(_configured_sensevoice_dir) if _configured_sensevoice_dir else next(
    (candidate for candidate in _sensevoice_candidates if candidate.is_dir()), APP_DIR / "sensevoice"
)
# The development tree serves seed data from public/. The portable package
# keeps the same files under dist/ so the server can run with an empty
# user-data directory after extraction.


def resolve_public_dir(app_dir: Path) -> Path:
    public_dir = app_dir / "public"
    return public_dir if public_dir.is_dir() else app_dir / "dist"


PUBLIC_DIR = resolve_public_dir(APP_DIR)
SEED_LIBRARY_FILE = PUBLIC_DIR / "data" / "library.json"
_configured_tools_dir = os.environ.get("SPEAKING_PRACTICE_TOOLS_DIR", "").strip()
_tool_candidates = (APP_DIR / "tools", PACKAGE_DIR / "tools")
TOOLS_DIR = Path(_configured_tools_dir) if _configured_tools_dir else next(
    (candidate for candidate in _tool_candidates if candidate.is_dir()), APP_DIR / "tools"
)
DEFAULT_USER_DATA_DIR = PACKAGE_DIR / "user-data" if (PACKAGE_DIR / "user-data").is_dir() else APP_DIR / "user-data"
DEFAULT_MODEL_DIR = PACKAGE_DIR / "models" / "sensevoice" if (PACKAGE_DIR / "models" / "sensevoice").is_dir() else APP_DIR / "models" / "sensevoice"


def resolve_user_data_dir() -> Path:
    configured = os.environ.get("SPEAKING_PRACTICE_DATA_DIR", "").strip()
    path = Path(configured) if configured else DEFAULT_USER_DATA_DIR
    return path if path.is_absolute() else APP_DIR / path


USER_DATA_DIR = resolve_user_data_dir()
MATERIALS_DIR = USER_DATA_DIR / "materials"
JOBS_DIR = USER_DATA_DIR / "jobs"
USER_LIBRARY_FILE = USER_DATA_DIR / "library.json"
DIAGNOSTIC_RECORDINGS_DIR = APP_DIR / "diagnostics" / "recordings"
MAX_DIAGNOSTIC_RECORDING_BYTES = 50 * 1024 * 1024

TERMINAL_STATES = {"completed", "failed", "cancelled"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts"}
SUPPORTED_BROWSERS = ("chrome", "edge")
NULLISH_PROCESS_OUTPUT = {"", "null", "none", "undefined"}


class UrlImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    browser: str | None = None


class RetryImportRequest(BaseModel):
    browser: str | None = Field(default=None, max_length=32)


class ImportCancelled(Exception):
    pass


class ImportFailure(Exception):
    def __init__(self, message: str, code: str, *, can_retry_browser: bool = False):
        super().__init__(message)
        self.message = message
        self.code = code
        self.can_retry_browser = can_retry_browser


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_data_dirs() -> None:
    for directory in (USER_DATA_DIR, MATERIALS_DIR, JOBS_DIR, DIAGNOSTIC_RECORDINGS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return fallback


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for attempt in range(8):
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.25 * (attempt + 1))


def read_user_library() -> dict[str, Any]:
    value = read_json(USER_LIBRARY_FILE, {"version": 1, "materials": []})
    if not isinstance(value, dict):
        return {"version": 1, "materials": []}
    materials = value.get("materials")
    if not isinstance(materials, list):
        value["materials"] = []
    return value


def save_user_library(value: dict[str, Any]) -> None:
    write_json_atomic(USER_LIBRARY_FILE, value)


def read_seed_library() -> dict[str, Any]:
    return read_json(SEED_LIBRARY_FILE, {"version": 1, "clipCount": 0, "authors": []})


def safe_filename(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", " ", value or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned[:120] or fallback).strip()


def normalize_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise ImportFailure("请输入完整的视频网址。", "invalid_url")
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), parsed.query, ""))


def platform_for_url(value: str) -> str:
    host = (urlsplit(value).hostname or "").lower()
    mapping = {
        "youtube.com": "youtube",
        "youtu.be": "youtube",
        "bilibili.com": "bilibili",
        "b23.tv": "bilibili",
        "douyin.com": "douyin",
        "iesdouyin.com": "douyin",
        "kuaishou.com": "kuaishou",
        "kwai.com": "kuaishou",
        "xiaohongshu.com": "xiaohongshu",
        "xhslink.com": "xiaohongshu",
        "weibo.com": "weibo",
        "weibo.cn": "weibo",
    }
    for suffix, name in mapping.items():
        if host == suffix or host.endswith("." + suffix):
            return name
    return host or "unknown"


def executable(name: str) -> str:
    candidates = [TOOLS_DIR / name, APP_DIR / name, Path(name)]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise ImportFailure(f"缺少 {name}，请检查运行包是否完整。", "tool_missing")


def javascript_runtime() -> str | None:
    configured = os.environ.get("SPEAKING_PRACTICE_JS_RUNTIME", "").strip()
    candidates = [
        Path(configured) if configured else None,
        PACKAGE_DIR / "runtime" / "js" / "deno.exe",
        APP_DIR / "runtime" / "js" / "deno.exe",
        TOOLS_DIR / "deno.exe",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return str(candidate)
    return shutil.which("deno.exe") or shutil.which("deno")


def yt_dlp_js_args() -> list[str]:
    runtime = javascript_runtime()
    return ["--js-runtimes", f"deno:{runtime}"] if runtime else []


def browser_profile_exists(browser: str) -> bool:
    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    if browser == "chrome":
        return (local_app_data / "Google" / "Chrome" / "User Data").is_dir()
    if browser == "edge":
        return (local_app_data / "Microsoft" / "Edge" / "User Data").is_dir()
    return False


def available_browsers() -> list[str]:
    return [browser for browser in SUPPORTED_BROWSERS if browser_profile_exists(browser)]


def is_nullish_process_output(value: Any) -> bool:
    return value is None or str(value).strip().lower() in NULLISH_PROCESS_OUTPUT


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    result = {key: value for key, value in job.items() if not key.startswith("_")}
    if result.get("status") == "failed" and is_nullish_process_output(result.get("error")):
        result["error"] = "该旧任务没有保存到具体错误，请重新添加视频网址后查看详细原因。"
    return result


def save_job(job: dict[str, Any]) -> None:
    write_json_atomic(JOBS_DIR / f"{job['id']}.json", public_job(job))


def new_job(kind: str, **values: Any) -> dict[str, Any]:
    job = {
        "id": f"job_{uuid.uuid4().hex[:12]}",
        "kind": kind,
        "status": "queued",
        "progress": 0,
        "step": "排队等待处理",
        "errorCode": None,
        "error": None,
        "canRetryWithBrowser": False,
        "canContinueWithFile": False,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        **values,
    }
    jobs[job["id"]] = job
    save_job(job)
    return job


def update_job(job: dict[str, Any], **values: Any) -> None:
    job.update(values)
    job["updatedAt"] = now_iso()
    save_job(job)


def redact_sensitive_process_text(value: str) -> str:
    redacted = re.sub(
        r"(?i)(\b(?:cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*).*$",
        r"\1[已隐藏]",
        value,
    )
    return redacted


def describe_process_output(lines: list[str]) -> str:
    meaningful: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if is_nullish_process_output(line):
            continue
        meaningful.append(redact_sensitive_process_text(line))
    errors = [line for line in meaningful if line.lower().startswith("error:")]
    candidates = errors or meaningful
    return candidates[-1][-600:] if candidates else "外部工具没有返回具体错误。"


def parse_metadata_payload(lines: list[str]) -> dict[str, Any]:
    """Parse yt-dlp JSON while tolerating runtime notices on merged stdout/stderr."""
    text = "\n".join(lines)
    decoder = json.JSONDecoder()
    for offset, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[offset:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise json.JSONDecodeError("metadata JSON object not found", text, 0)


active_processes: dict[str, subprocess.Popen[str]] = {}
cancel_events: dict[str, threading.Event] = {}


def run_process(command: list[str], job: dict[str, Any], *, cwd: Path | None = None) -> list[str]:
    event = cancel_events[job["id"]]
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd or APP_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creation_flags,
        )
    except FileNotFoundError as error:
        raise ImportFailure(f"找不到工具：{command[0]}", "tool_missing") from error

    active_processes[job["id"]] = process
    lines: list[str] = []
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            if event.is_set():
                process.terminate()
                raise ImportCancelled()
            line = raw_line.strip()
            if line:
                lines.append(line)
        return_code = process.wait()
    finally:
        active_processes.pop(job["id"], None)

    if event.is_set():
        raise ImportCancelled()
    if return_code != 0:
        raise ImportFailure(describe_process_output(lines), "external_tool_failed")
    return lines


def run_capture(command: list[str], *, cwd: Path | None = None) -> str:
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd or APP_DIR),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation_flags,
        )
    except FileNotFoundError as error:
        raise ImportFailure(f"找不到工具：{command[0]}", "tool_missing") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()[-600:]
        raise ImportFailure(detail or "媒体检查失败。", "media_invalid") from error
    return result.stdout.strip()


def ffprobe(path: Path) -> dict[str, Any]:
    output = run_capture([
        executable("ffprobe.exe"),
        "-v", "error",
        "-show_entries", "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height",
        "-of", "json", str(path),
    ])
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise ImportFailure("视频信息读取失败。", "media_invalid") from error


def media_duration(probe: dict[str, Any]) -> float:
    try:
        duration = float(probe.get("format", {}).get("duration", 0))
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        raise ImportFailure("视频没有可用的时长信息。", "media_invalid")
    return duration


def has_audio(probe: dict[str, Any]) -> bool:
    return any(stream.get("codec_type") == "audio" for stream in probe.get("streams", []))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_login_error(message: str) -> bool:
    lowered = message.lower()
    patterns = (
        "sign in",
        "login",
        "log in",
        "private video",
        "age-restricted",
        "authentication",
        "cookies",
        "需要登录",
        "登录",
        "仅限会员",
    )
    return any(pattern in lowered for pattern in patterns)


def is_browser_cookie_error(message: str) -> bool:
    lowered = message.lower()
    patterns = (
        "failed to decrypt with dpapi",
        "could not copy chrome cookie database",
        "could not copy cookie database",
        "failed to copy cookie database",
        "failed to decrypt cookies",
        "unable to decrypt cookies",
    )
    return any(pattern in lowered for pattern in patterns)


def is_bilibili_http_412(message: str, url: str) -> bool:
    return platform_for_url(url) == "bilibili" and bool(
        re.search(r"(?:http\s+error\s+412|412\s*:\s*precondition\s+failed)", message, re.IGNORECASE)
    )


def browser_display_name(browser: str) -> str:
    return "Chrome" if browser == "chrome" else "Edge" if browser == "edge" else browser


def contextualize_url_failure(error: ImportFailure, url: str, browser: str | None) -> ImportFailure:
    detail = error.message
    if browser and is_browser_cookie_error(detail):
        name = browser_display_name(browser)
        return ImportFailure(
            f"无法读取 {name} 登录状态。请完全退出 {name} 后重试；若仍失败，请换另一个浏览器或改用本地文件。工具返回：{detail}",
            "browser_cookies_unavailable",
            can_retry_browser=True,
        )
    if is_bilibili_http_412(detail, url):
        if not browser:
            return ImportFailure(
                f"B站拒绝了公开读取（HTTP 412: Precondition Failed）。请选择已登录的 Chrome 或 Edge 重试。工具返回：{detail}",
                "login_required",
                can_retry_browser=True,
            )
        name = browser_display_name(browser)
        return ImportFailure(
            f"使用 {name} 登录状态后，B站仍拒绝读取（HTTP 412: Precondition Failed）。请稍后再试或改用本地文件。工具返回：{detail}",
            "platform_access_denied",
        )
    if is_login_error(detail) and not browser:
        return ImportFailure(
            f"这个视频需要登录，请选择已登录的 Chrome 或 Edge 后重试。工具返回：{detail}",
            "login_required",
            can_retry_browser=True,
        )
    return error


def normalized_cues(cues: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    """Clamp, order and repair short orphan cues from ASR word timestamps."""
    from scripts.build_dataset import LocalTranscriber

    domain_suffixes = {"com", "org", "net", "co", "cn", "io", "ai", "tv"}
    domain_hints = ("website", "www", "http", "learningenglish", "bblearningenglish")

    def is_domain_suffix(text: str) -> str | None:
        candidate = re.sub(r"[.!?。！？]+$", "", text.strip()).casefold()
        return candidate if candidate in domain_suffixes else None

    def has_domain_hint(text: str) -> bool:
        compact = re.sub(r"\s+", "", text).casefold()
        return any(hint in compact for hint in domain_hints)

    def is_punctuation_only(text: str) -> bool:
        return not re.search(r"[A-Za-z0-9\u3400-\u9fff]", text)

    ordered: list[dict[str, Any]] = []
    for cue in cues:
        try:
            start = max(0.0, min(duration, float(cue.get("start", 0))))
            end = max(start + 0.05, min(duration, float(cue.get("end", 0))))
        except (TypeError, ValueError):
            continue
        text = re.sub(r"\s+", " ", str(cue.get("text", ""))).strip()
        if not text or end <= start or is_punctuation_only(text):
            continue
        # SenseVoice may label a several-second background/noise segment as a
        # one-word sentence. Keep short real speech, but discard this known
        # shape before it can become a training line of its own.
        if (
            text.casefold() in {"the", "the.", "a", "a.", "an", "an."}
            and end - start >= 1.5
        ):
            continue
        start = max(start, ordered[-1]["end"] if ordered else 0.0)
        if end <= start:
            continue
        ordered.append({"start": round(start, 3), "end": round(end, 3), "text": text, "speaker": cue.get("speaker")})

    repaired: list[dict[str, Any]] = []
    terminal = re.compile(r"[.!?。！？]$")
    decimal_bridge = re.compile(r"([0-9〇零一二三四五六七八九十百千万亿两])\.$")
    for cue in ordered:
        if repaired:
            previous = repaired[-1]
            short_orphan = len(cue["text"].split()) <= 2 and not terminal.search(previous["text"])
            close_enough = cue["start"] - previous["end"] <= 0.7
            decimal_match = decimal_bridge.search(previous["text"])
            leading_digits = re.match(r"^([0-9]+)(.*)$", cue["text"])
            if decimal_match and leading_digits and close_enough:
                previous["text"] = f"{previous['text'][:-1]} .".replace(" .", ".")
                previous["text"] += f"{leading_digits.group(1)}{leading_digits.group(2)}"
                previous["end"] = cue["end"]
                continue
            suffix = is_domain_suffix(cue["text"])
            if suffix and close_enough and has_domain_hint(previous["text"]):
                trailing = re.search(r"[.!?。！？]+$", cue["text"].strip())
                punctuation = trailing.group(0) if trailing else ""
                previous["text"] = f"{re.sub(r'[.!?。！？,，;；:：]+$', '', previous['text'].rstrip())}.{suffix}{punctuation}"
                previous["end"] = cue["end"]
                continue
            domain_prefix = re.match(r"^(com|org|net|co|cn|io|ai|tv)\b\s*(.*)$", cue["text"].strip(), flags=re.IGNORECASE)
            if domain_prefix and close_enough and has_domain_hint(previous["text"]):
                suffix_name = domain_prefix.group(1).casefold()
                remainder = domain_prefix.group(2).strip()
                previous_text = re.sub(r"[.!?。！？,，;；:：]+$", "", previous["text"].rstrip())
                previous["text"] = f"{previous_text}.{suffix_name}."
                if remainder:
                    previous["text"] += f" {remainder}"
                previous["end"] = cue["end"]
                continue
            if short_orphan and close_enough:
                previous["text"] = f"{previous['text']} {cue['text']}".strip()
                previous["end"] = cue["end"]
                continue
        repaired.append(cue)
    return LocalTranscriber.merge_cue_boundaries(repaired)


def write_srt(path: Path, cues: list[dict[str, Any]]) -> None:
    def timestamp(seconds: float) -> str:
        milliseconds = max(0, round(seconds * 1000))
        hours, milliseconds = divmod(milliseconds, 3_600_000)
        minutes, milliseconds = divmod(milliseconds, 60_000)
        seconds_part, milliseconds = divmod(milliseconds, 1_000)
        return f"{hours:02d}:{minutes:02d}:{seconds_part:02d},{milliseconds:03d}"

    lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        lines.extend([str(index), f"{timestamp(cue['start'])} --> {timestamp(cue['end'])}", cue["text"], ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def repair_material_cues(raw_cues: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    """Use SenseVoice grouping plus the final local boundary-repair guards."""
    return normalized_cues(raw_cues, duration)


_transcriber: Any = None
_transcriber_lock = threading.Lock()
_word_timeline_lock = threading.Lock()


def model_directory() -> Path:
    configured = os.environ.get("SPEAKING_PRACTICE_SENSEVOICE_MODEL", "").strip()
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else APP_DIR / path
    return DEFAULT_MODEL_DIR


def model_ready() -> bool:
    path = model_directory()
    required_files = (
        path / "model.pt",
        path / "config.yaml",
        path / "tokens.json",
        path / "dependencies" / "fsmn-vad" / "model.pt",
        path / "dependencies" / "ct-punc" / "model.pt",
        path / "dependencies" / "ct-punc" / "tokens.json",
        path / "dependencies" / "cam++" / "campplus_cn_common.bin",
    )
    return path.is_dir() and all(item.is_file() for item in required_files)


def get_transcriber() -> Any:
    global _transcriber
    if not model_ready():
        raise ImportFailure(
            "本地语音模型还没有就绪，请将模型包解压到 models\\sensevoice 后重新检测。",
            "model_missing",
        )
    with _transcriber_lock:
        if _transcriber is None:
            sys.path.insert(0, str(APP_DIR))
            sys.path.insert(0, str(SENSEVOICE_DIR))
            from scripts.build_dataset import LocalTranscriber

            os.environ.setdefault("SPEAKING_PRACTICE_SENSEVOICE_MODEL", str(model_directory()))
            bundled_remote_code = SENSEVOICE_DIR / "model.py"
            if bundled_remote_code.is_file():
                # FunASR's dynamic importer splits remote_code on '/'. Keep
                # the Windows path absolute while using separators it can
                # load correctly.
                os.environ.setdefault("SPEAKING_PRACTICE_SENSEVOICE_REMOTE_CODE", bundled_remote_code.as_posix())
            _transcriber = LocalTranscriber(os.environ.get("SENSEVOICE_DEVICE", "cpu"))
    return _transcriber


def resolve_audio_path(audio_url: str) -> Path:
    """Resolve a local audio URL without allowing paths outside app data."""
    parsed = urlsplit(audio_url.strip())
    path = parsed.path
    if path.startswith("/media/"):
        root = PUBLIC_DIR
        relative = path.removeprefix("/")
    elif path.startswith("/user-data/"):
        root = USER_DATA_DIR
        relative = path.removeprefix("/user-data/")
    else:
        raise HTTPException(status_code=400, detail="只支持当前训练素材里的本地音频。")

    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise HTTPException(status_code=400, detail="音频路径无效。")
    return candidate


def generate_word_timeline(audio_path: Path) -> dict[str, Any]:
    """Create and cache a raw FunASR timeline for a seed clip on first use."""
    target = audio_path.parent / "transcription.json"
    with _word_timeline_lock:
        cached = read_json(target, None)
        if isinstance(cached, dict) and (cached.get("words") or cached.get("segments")):
            return cached
        raw, _ = get_transcriber().transcribe(audio_path)
        write_json_atomic(target, raw)
        return raw


def metadata_from_probe(path: Path, title: str) -> dict[str, Any]:
    probe = ffprobe(path)
    if not has_audio(probe):
        raise ImportFailure("这个文件没有音轨，无法生成口播字幕。", "audio_missing")
    streams = probe.get("streams", [])
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    if not video_stream:
        raise ImportFailure("这个文件没有视频画面。", "video_missing")
    return {
        "duration": media_duration(probe),
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "title": title,
    }


def url_metadata(job: dict[str, Any], url: str, browser: str | None) -> dict[str, Any]:
    command = [executable("yt-dlp.exe"), "--no-warnings", "--no-playlist", "--dump-single-json", "--skip-download"]
    command.extend(yt_dlp_js_args())
    if browser:
        command.extend(["--cookies-from-browser", browser])
    command.append(url)
    try:
        lines = run_process(command, job)
    except ImportFailure as error:
        contextualized = contextualize_url_failure(error, url, browser)
        if contextualized is error:
            raise
        raise contextualized from error
    try:
        return parse_metadata_payload(lines)
    except json.JSONDecodeError as error:
        raise ImportFailure("网址信息读取失败，请确认这是单个视频网址。", "metadata_invalid") from error


def download_url(job: dict[str, Any], url: str, browser: str | None, work_dir: Path) -> Path:
    download_dir = work_dir / "download"
    download_dir.mkdir(parents=True, exist_ok=True)
    command = [
        executable("yt-dlp.exe"),
        "--no-warnings", "--no-playlist", "--restrict-filenames",
        "-f", "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
        "--merge-output-format", "mp4",
        "--recode-video", "mp4",
        "-o", str(download_dir / "source.%(ext)s"),
    ]
    command.extend(yt_dlp_js_args())
    if (TOOLS_DIR / "ffmpeg.exe").is_file():
        command.extend(["--ffmpeg-location", str(TOOLS_DIR)])
    if browser:
        command.extend(["--cookies-from-browser", browser])
    command.append(url)
    try:
        run_process(command, job)
    except ImportFailure as error:
        contextualized = contextualize_url_failure(error, url, browser)
        if contextualized is error:
            raise
        raise contextualized from error
    candidates = [path for path in download_dir.iterdir() if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS]
    if not candidates:
        raise ImportFailure("网址下载完成，但没有找到视频文件。", "download_empty")
    return max(candidates, key=lambda path: path.stat().st_size)


def normalize_video(job: dict[str, Any], source: Path, destination: Path) -> None:
    update_job(job, status="converting", progress=48, step="正在整理视频格式")
    run_process([
        executable("ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(destination),
    ], job)


def extract_audio(job: dict[str, Any], video: Path, audio: Path, wav: Path) -> None:
    update_job(job, status="converting", progress=55, step="正在提取音频")
    run_process([
        executable("ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
    ], job)
    run_process([
        executable("ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video), "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", str(audio),
    ], job)


def make_poster(job: dict[str, Any], video: Path, poster: Path) -> Path:
    update_job(job, status="generating", progress=88, step="正在生成封面")
    try:
        run_process([
            executable("ffmpeg.exe"), "-y", "-hide_banner", "-loglevel", "error",
            "-ss", "1", "-i", str(video), "-frames:v", "1", "-q:v", "3", str(poster),
        ], job)
        return poster
    except ImportFailure:
        fallback = poster.with_suffix(".svg")
        fallback.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">'
            '<rect width="1280" height="720" fill="#171717"/><text x="64" y="650" fill="#fff" '
            'font-family="Arial,sans-serif" font-size="42">口语跟练室</text></svg>',
            encoding="utf-8",
        )
        return fallback


def language_from_cues(cues: list[dict[str, Any]]) -> str:
    text = "".join(str(cue.get("text", "")) for cue in cues)
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if chinese and chinese >= latin:
        return "zh"
    if latin:
        return "en"
    return "other"


def metadata_text(metadata: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = metadata.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def author_from_metadata(metadata: dict[str, Any]) -> tuple[str, str]:
    """Read the common yt-dlp uploader fields across video platforms."""
    name = metadata_text(metadata, "uploader", "channel", "creator", "artist")
    author_id = metadata_text(metadata, "uploader_id", "channel_id", "creator_id", "artist_id")
    return name, author_id


def is_bbc_learning_english_url(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlsplit(value)
    host = parsed.netloc.casefold().split(":", 1)[0]
    path = parsed.path.casefold()
    return host.endswith("bbc.co.uk") and "/learningenglish/" in path


def existing_materials() -> list[dict[str, Any]]:
    return [item for item in read_user_library().get("materials", []) if isinstance(item, dict)]


def find_duplicate(source_url: str | None, content_hash: str | None) -> dict[str, Any] | None:
    for material in existing_materials():
        if source_url and material.get("sourceUrl") == source_url:
            return material
        if content_hash and material.get("contentHash") == content_hash:
            return material
    return None


def to_clip(material: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": material["id"],
        "title": material["title"],
        "sourceTitle": material["title"],
        "sourceUrl": material.get("sourceUrl", ""),
        "duration": material["duration"],
        "video": material["video"],
        "audio": material.get("audio", ""),
        "subtitle": material.get("subtitle", ""),
        "poster": material["poster"],
        "cues": material["cues"],
        "sourceType": material.get("sourceType", "file"),
        "platform": material.get("platform", "local"),
        "language": material.get("language", "unknown"),
        "authorName": material.get("authorName", ""),
        "authorId": material.get("authorId", ""),
        "isUserMaterial": True,
    }


def user_author_group_id(material: dict[str, Any]) -> str:
    platform = str(material.get("platform") or "local").strip().lower()
    author_id = str(material.get("authorId") or "").strip().lower()
    author_name = str(material.get("authorName") or "").strip().casefold()
    identity = author_id or author_name
    if not identity:
        return "my-videos"
    digest = hashlib.sha1(f"{platform}:{identity}".encode("utf-8")).hexdigest()[:12]
    return f"user-author-{digest}"


def author_name_key(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def merged_library() -> dict[str, Any]:
    seed = read_seed_library()
    authors = list(seed.get("authors", []))
    materials = existing_materials()
    if materials:
        grouped: dict[str, dict[str, Any]] = {}
        for material in materials:
            group_id = user_author_group_id(material)
            if group_id not in grouped:
                author_name = str(material.get("authorName") or "").strip()
                grouped[group_id] = {
                    "id": group_id,
                    "name": author_name or "我的视频",
                    "avatar": material.get("poster", ""),
                    "isUser": True,
                    "clips": [],
                }
            grouped[group_id]["clips"].append(to_clip(material))
        for user_author in grouped.values():
            match = next(
                (
                    item
                    for item in authors
                    if author_name_key(item.get("name"))
                    and author_name_key(item.get("name")) == author_name_key(user_author.get("name"))
                ),
                None,
            )
            if match is None:
                authors.append(user_author)
                continue
            match.setdefault("clips", []).extend(user_author["clips"])
            match["hasUserClips"] = True
            if not match.get("avatar"):
                match["avatar"] = user_author.get("avatar", "")
    return {
        **seed,
        "version": max(2, int(seed.get("version", 1))),
        "clipCount": sum(len(author.get("clips", [])) for author in authors),
        "authors": authors,
        "userMaterialCount": len(materials),
    }


def process_import(job: dict[str, Any]) -> None:
    job_id = job["id"]
    job_dir = JOBS_DIR / job_id
    work_dir = job_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    created_material_dir: Path | None = None
    cancel_events[job_id] = threading.Event()
    try:
        update_job(job, status="downloading" if job["kind"] == "url" else "converting", progress=8, step="正在准备视频")
        source_url = job.get("sourceUrl")
        browser = job.get("browser")
        metadata: dict[str, Any]
        if job["kind"] == "url":
            source_url = normalize_url(str(source_url))
            metadata = url_metadata(job, source_url, browser)
            update_job(job, progress=22, step="正在下载视频")
            source_path = download_url(job, source_url, browser, work_dir)
            title = safe_filename(str(metadata.get("title") or source_url), "未命名视频")
            platform = platform_for_url(source_url)
            author_name, author_id = author_from_metadata(metadata)
            if not author_name and is_bbc_learning_english_url(source_url):
                author_name, author_id = "BBC Learning English", "@bbclearningenglish"
            content_hash = None
        else:
            source_path = Path(job["_inputPath"])
            if not source_path.is_file():
                raise ImportFailure("找不到上传的视频文件。", "input_missing")
            title = safe_filename(str(job.get("originalName") or source_path.stem), "未命名视频")
            metadata = metadata_from_probe(source_path, title)
            platform = "local"
            author_name, author_id = "", ""
            content_hash = sha256_file(source_path)

        duplicate = find_duplicate(source_url, content_hash)
        if duplicate:
            update_job(
                job,
                status="completed",
                progress=100,
                step="已存在相同素材",
                materialId=duplicate.get("id"),
                duplicateOf=duplicate.get("id"),
            )
            return

        material_id = f"material_{uuid.uuid4().hex[:12]}"
        material_dir = MATERIALS_DIR / material_id
        created_material_dir = material_dir
        material_dir.mkdir(parents=True, exist_ok=True)
        video_path = material_dir / "video.mp4"
        audio_path = material_dir / "audio.mp3"
        wav_path = work_dir / "audio.wav"
        subtitle_path = material_dir / "transcript.srt"
        cues_path = material_dir / "cues.json"
        raw_path = material_dir / "transcription.json"
        poster_path = material_dir / "poster.jpg"

        normalize_video(job, source_path, video_path)
        probe = metadata_from_probe(video_path, title)
        extract_audio(job, video_path, audio_path, wav_path)
        update_job(job, status="transcribing", progress=62, step="正在识别字幕")
        transcriber = get_transcriber()
        raw, raw_cues = transcriber.transcribe(wav_path)
        cues = repair_material_cues(raw_cues, probe["duration"])
        if not cues:
            raise ImportFailure("没有识别到可用字幕，请换一个有清晰人声的视频。", "transcription_empty")
        write_srt(subtitle_path, cues)
        write_json_atomic(cues_path, cues)
        write_json_atomic(raw_path, raw)
        poster_path = make_poster(job, video_path, poster_path)

        relative_root = f"/user-data/materials/{material_id}"
        material = {
            "id": material_id,
            "title": title,
            "sourceType": job["kind"],
            "sourceUrl": source_url or "",
            "platform": platform,
            "authorName": author_name,
            "authorId": author_id,
            "importedAt": now_iso(),
            "contentHash": content_hash,
            "language": language_from_cues(cues),
            "duration": round(float(probe["duration"]), 3),
            "video": f"{relative_root}/video.mp4",
            "audio": f"{relative_root}/audio.mp3",
            "subtitle": f"{relative_root}/transcript.srt",
            "poster": f"{relative_root}/poster.jpg" if poster_path.suffix == ".jpg" else f"{relative_root}/poster.svg",
            "cues": cues,
        }
        user_library = read_user_library()
        user_library.setdefault("materials", []).append(material)
        save_user_library(user_library)
        update_job(job, status="completed", progress=100, step="导入完成", materialId=material_id)
    except ImportCancelled:
        if created_material_dir and created_material_dir.is_dir():
            shutil.rmtree(created_material_dir, ignore_errors=True)
        update_job(job, status="cancelled", progress=0, step="已取消", errorCode="cancelled", error="任务已取消。")
    except ImportFailure as error:
        if created_material_dir and created_material_dir.is_dir():
            shutil.rmtree(created_material_dir, ignore_errors=True)
        update_job(
            job,
            status="failed",
            progress=0,
            step="导入失败",
            errorCode=error.code,
            error=error.message,
            canRetryWithBrowser=error.can_retry_browser,
            canContinueWithFile=job["kind"] == "url",
        )
    except Exception as error:  # Keep the user-facing job alive even on unexpected tools/runtime errors.
        if created_material_dir and created_material_dir.is_dir():
            shutil.rmtree(created_material_dir, ignore_errors=True)
        update_job(job, status="failed", progress=0, step="导入失败", errorCode="unexpected", error=str(error)[-600:], canContinueWithFile=job["kind"] == "url")
    finally:
        cancel_events.pop(job_id, None)


jobs: dict[str, dict[str, Any]] = {}
job_queue: asyncio.Queue[str] = asyncio.Queue()
worker_task: asyncio.Task[Any] | None = None


def load_jobs() -> None:
    for path in JOBS_DIR.glob("job_*.json"):
        value = read_json(path, None)
        if not isinstance(value, dict) or not value.get("id"):
            continue
        if value.get("status") not in TERMINAL_STATES:
            value.update({"status": "failed", "step": "应用关闭前任务未完成", "errorCode": "interrupted", "error": "上次任务没有完成，可以重新添加。"})
        jobs[value["id"]] = value


async def worker_loop() -> None:
    while True:
        job_id = await job_queue.get()
        try:
            job = jobs.get(job_id)
            if job and job.get("status") == "queued":
                await asyncio.to_thread(process_import, job)
        finally:
            job_queue.task_done()


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_data_dirs()
    load_jobs()
    global worker_task
    worker_task = asyncio.create_task(worker_loop())
    yield
    if worker_task and not worker_task.done():
        worker_task.cancel()
        await asyncio.gather(worker_task, return_exceptions=True)


app = FastAPI(title="Spoken Practice Local Service", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/system/capabilities")
async def capabilities() -> dict[str, Any]:
    return {
        "ytDlp": bool(find_tool("yt-dlp.exe")),
        "ffmpeg": bool(find_tool("ffmpeg.exe")),
        "ffprobe": bool(find_tool("ffprobe.exe")),
        "javascriptRuntime": bool(javascript_runtime()),
        "modelReady": model_ready(),
        "browsers": available_browsers(),
        "dataDir": str(USER_DATA_DIR),
    }


@app.get("/api/word-timings")
async def word_timings(audio: str = "") -> dict[str, Any]:
    """Return cached timings or build them locally for a seed audio clip."""
    audio_path = resolve_audio_path(audio)
    if not audio_path.is_file():
        raise HTTPException(status_code=404, detail="找不到对应的训练音频。")
    try:
        return await asyncio.to_thread(generate_word_timeline, audio_path)
    except ImportFailure as error:
        raise HTTPException(status_code=503, detail=error.message) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"词语时间轴生成失败：{error}") from error


def find_tool(name: str) -> str | None:
    for candidate in (TOOLS_DIR / name, APP_DIR / name, Path(name)):
        if candidate.is_file():
            return str(candidate)
    return shutil.which(name)


@app.get("/api/library")
async def library() -> dict[str, Any]:
    ensure_data_dirs()
    return merged_library()


@app.get("/api/imports")
async def imports(limit: int = 20) -> list[dict[str, Any]]:
    ordered = sorted(jobs.values(), key=lambda value: (value.get("createdAt", ""), value.get("id", "")))
    requested = max(1, min(limit, 100))
    return [public_job(item) for item in ordered[-requested:]]


@app.get("/api/imports/{job_id}")
async def import_status(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="找不到这个导入任务。")
    return public_job(job)


@app.post("/api/imports/url")
async def import_url(request: UrlImportRequest) -> dict[str, Any]:
    ensure_data_dirs()
    try:
        url = normalize_url(request.url)
    except ImportFailure as error:
        raise HTTPException(status_code=400, detail=error.message) from error
    if request.browser and request.browser not in SUPPORTED_BROWSERS:
        raise HTTPException(status_code=400, detail="暂时只支持 Chrome 和 Edge 登录态。")
    job = new_job("url", sourceUrl=url, platform=platform_for_url(url), browser=request.browser)
    await job_queue.put(job["id"])
    return public_job(job)


@app.post("/api/imports/file")
async def import_file(file: UploadFile = File(...)) -> dict[str, Any]:
    ensure_data_dirs()
    original_name = safe_filename(file.filename or "video.mp4", "video.mp4")
    extension = Path(original_name).suffix.lower()
    if extension not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="请选择 MP4、MOV、MKV、WebM 等视频文件。")
    job = new_job("file", originalName=original_name)
    job_dir = JOBS_DIR / job["id"]
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / f"input{extension}"
    try:
        with input_path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                output.write(chunk)
    finally:
        await file.close()
    job["_inputPath"] = str(input_path)
    save_job(job)
    await job_queue.put(job["id"])
    return public_job(job)


@app.post("/api/imports/{job_id}/retry")
async def retry_import(job_id: str, request: RetryImportRequest) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="找不到这个导入任务。")
    if job.get("status") != "failed":
        raise HTTPException(status_code=400, detail="只有失败的任务可以重试。")
    if job.get("kind") == "url":
        browser = request.browser or job.get("browser")
        if browser and browser not in SUPPORTED_BROWSERS:
            raise HTTPException(status_code=400, detail="暂时只支持 Chrome 和 Edge 登录态。")
        job["browser"] = browser
        retry_step = "等待重新导入"
    elif job.get("kind") == "file":
        input_path = Path(str(job.get("_inputPath") or ""))
        if not input_path.is_file():
            raise HTTPException(status_code=400, detail="原视频文件已不存在，请重新选择视频。")
        retry_step = "等待重新处理"
    else:
        raise HTTPException(status_code=400, detail="暂时不支持重试这个任务。")
    update_job(job, status="queued", progress=0, step=retry_step, error=None, errorCode=None, canRetryWithBrowser=False, canContinueWithFile=False)
    await job_queue.put(job_id)
    return public_job(job)


@app.post("/api/imports/{job_id}/cancel")
async def cancel_import(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="找不到这个导入任务。")
    if job.get("status") in {"completed", "cancelled"}:
        return public_job(job)
    event = cancel_events.get(job_id)
    if event:
        event.set()
        process = active_processes.get(job_id)
        if process and process.poll() is None:
            process.terminate()
    update_job(job, status="cancelled", progress=0, step="已取消", errorCode="cancelled", error="任务已取消。")
    return public_job(job)


@app.post("/api/imports/{job_id}/continue-with-file")
async def continue_with_file(job_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job or job.get("kind") != "url" or job.get("status") != "failed":
        raise HTTPException(status_code=400, detail="只有失败的网址任务可以改用本地文件。")
    return await import_file(file)


@app.post("/api/diagnostics/recording")
async def save_diagnostic_recording(request: Request) -> dict[str, Any]:
    """保存浏览器录音到项目所在磁盘，供本地评分问题排查使用。"""
    ensure_data_dirs()
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="录音内容为空。")
    if len(payload) > MAX_DIAGNOSTIC_RECORDING_BYTES:
        raise HTTPException(status_code=413, detail="录音文件超过 50 MB，暂时无法保存。")

    content_type = (request.headers.get("content-type") or "audio/webm").split(";", 1)[0].strip().lower()
    extension = {
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "video/webm": ".webm",
        "video/mp4": ".mp4",
    }.get(content_type, ".webm")
    clip_id = safe_filename(request.headers.get("x-clip-id", "clip"), "clip")
    cue_index = safe_filename(request.headers.get("x-cue-index", "0"), "0")
    timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    target = DIAGNOSTIC_RECORDINGS_DIR / f"{timestamp}_{uuid.uuid4().hex[:8]}_{clip_id}_cue-{cue_index}{extension}"
    target.write_bytes(payload)
    return {"ok": True, "filename": target.name, "path": str(target)}


@app.delete("/api/materials/{material_id}")
async def delete_material(material_id: str) -> dict[str, Any]:
    user_library = read_user_library()
    materials = user_library.get("materials", [])
    target = next((item for item in materials if item.get("id") == material_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="找不到这个素材。")
    user_library["materials"] = [item for item in materials if item.get("id") != material_id]
    save_user_library(user_library)
    material_dir = MATERIALS_DIR / material_id
    if material_dir.is_dir():
        shutil.rmtree(material_dir)
    return {"ok": True, "id": material_id}


ensure_data_dirs()
app.mount("/user-data", StaticFiles(directory=str(USER_DATA_DIR)), name="user-data")
if (APP_DIR / "dist").is_dir():
    app.mount("/", StaticFiles(directory=str(APP_DIR / "dist"), html=True), name="frontend")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4321)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
