#!/usr/bin/env python3
"""
Generate sidecar voice packs (voices/voice_pack.js and voices/voice_pack_en.js)
from voices/voice_manifest.json.
Supports:
  - --lang {zh,en,all} (default all)
  - edge-tts neural voices (default in auto mode when installed and online)
  - Windows System.Speech (SAPI) offline fallback (zh-* and en-*)
  - --check mode for full ZH + EN manifest validation
  - --incremental mode per output file to reuse matching audio blobs
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import datetime
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT_DIR / "voices" / "voice_manifest.json"
OUTPUT_JS_ZH_PATH = ROOT_DIR / "voices" / "voice_pack.js"
OUTPUT_JS_EN_PATH = ROOT_DIR / "voices" / "voice_pack_en.js"

LANG_CONFIG = {
    "zh": {
        "output_path": OUTPUT_JS_ZH_PATH,
        "tts_field": "ttsText",
        "display_field": "displayText",
        "voice_field": "edgeVoice",
        "rate_field": "rate",
        "pitch_field": "pitch",
        "sapi_culture": "zh-*",
    },
    "en": {
        "output_path": OUTPUT_JS_EN_PATH,
        "tts_field": "ttsTextEn",
        "display_field": "displayTextEn",
        "voice_field": "edgeVoiceEn",
        "rate_field": "rateEn",
        "pitch_field": "pitchEn",
        "sapi_culture": "en-*",
    },
}


def _require_non_empty_str(mapping: dict, key: str, context: str) -> str:
    val = mapping.get(key)
    if not isinstance(val, str) or not val.strip():
        raise ValueError(f"{context} must have non-empty string '{key}'.")
    return val.strip()


def load_and_validate_manifest(path: pathlib.Path) -> dict:
    """Load voice manifest and validate schema, ZH + EN roles, and unique non-empty clips."""
    data = json.loads(path.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, int) or version < 2:
        raise ValueError(f"Manifest 'version' must be >= 2 (got {version!r}).")

    roles = data.get("roles") or {}
    clips = data.get("clips") or []
    if not isinstance(roles, dict) or not roles or not isinstance(clips, list) or not clips:
        raise ValueError("Manifest must contain non-empty 'roles' and 'clips'.")

    for role_name, role_cfg in roles.items():
        if not isinstance(role_cfg, dict):
            raise ValueError(f"Role '{role_name}' must be an object.")
        ctx = f"Role '{role_name}'"
        for field in (
            "speakerLabel",
            "speakerLabelEn",
            "edgeVoice",
            "rate",
            "pitch",
            "edgeVoiceEn",
            "rateEn",
            "pitchEn",
        ):
            _require_non_empty_str(role_cfg, field, ctx)
        for num_field in ("speechPitch", "speechRate"):
            num_val = role_cfg.get(num_field)
            if not isinstance(num_val, (int, float)) or num_val <= 0:
                raise ValueError(f"{ctx} must have positive number '{num_field}'.")

    seen_ids: set[str] = set()
    for idx, clip in enumerate(clips):
        if not isinstance(clip, dict):
            raise ValueError(f"Clip at index {idx} must be an object.")
        cid = _require_non_empty_str(clip, "id", f"Clip at index {idx}")
        if cid in seen_ids:
            raise ValueError(f"Duplicate clip id detected: '{cid}'.")
        ctx = f"Clip '{cid}'"
        role = _require_non_empty_str(clip, "role", ctx)
        if role not in roles:
            raise ValueError(f"{ctx} references unknown role '{role}'.")
        priority = clip.get("priority")
        if not isinstance(priority, int) or priority < 1:
            raise ValueError(f"{ctx} must have positive integer 'priority'.")
        cooldown = clip.get("cooldownSec", 0)
        if not isinstance(cooldown, (int, float)) or cooldown < 0:
            raise ValueError(f"{ctx} must have non-negative 'cooldownSec'.")
        for text_field in ("displayText", "ttsText", "displayTextEn", "ttsTextEn"):
            _require_non_empty_str(clip, text_field, ctx)
        seen_ids.add(cid)

    return data


async def synthesize_edge_clip(
    clip: dict, role_cfg: dict, out_path: pathlib.Path, lang: str
) -> bytes:
    """Synthesize a single MP3 clip using edge-tts for the specified language."""
    import edge_tts

    cfg = LANG_CONFIG[lang]
    text = clip[cfg["tts_field"]]
    voice = role_cfg[cfg["voice_field"]]
    rate = role_cfg.get(cfg["rate_field"], "+0%")
    pitch = role_cfg.get(cfg["pitch_field"], "+0Hz")

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(
                text=text,
                voice=voice,
                rate=rate,
                pitch=pitch,
            )
            await communicate.save(str(out_path))
            raw = out_path.read_bytes()
            if len(raw) < 200:
                raise RuntimeError(f"Synthesized empty/too-small audio for {clip['id']} ({len(raw)} bytes)")
            return raw
        except Exception as exc:
            last_exc = exc
            if attempt < 2:
                await asyncio.sleep(0.8 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


async def generate_with_edge(manifest: dict, lang: str) -> tuple[dict[str, dict], str]:
    """Generate all clips concurrently (throttled) using edge-tts."""
    roles = manifest["roles"]
    clips = manifest["clips"]
    results: dict[str, dict] = {}
    semaphore = asyncio.Semaphore(4)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = pathlib.Path(tmpdir)

        async def _worker(clip: dict) -> None:
            cid = clip["id"]
            role_cfg = roles[clip["role"]]
            out_file = tmp / f"{cid}.{lang}.mp3"
            async with semaphore:
                raw = await synthesize_edge_clip(clip, role_cfg, out_file, lang)
            results[cid] = {
                "mime": "audio/mpeg",
                "data": base64.b64encode(raw).decode("ascii"),
                "bytes": len(raw),
            }

        await asyncio.gather(*(_worker(c) for c in clips))

    return results, "edge-tts"


def generate_with_sapi(manifest: dict, lang: str) -> tuple[dict[str, dict], str]:
    """Offline Windows fallback using PowerShell System.Speech (supports zh-* and en-*)."""
    cfg = LANG_CONFIG[lang]
    clips = manifest["clips"]
    results: dict[str, dict] = {}

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = pathlib.Path(tmpdir)
        jobs = []
        for clip in clips:
            out_wav = tmp / f"{clip['id']}.{lang}.wav"
            jobs.append({"id": clip["id"], "text": clip[cfg["tts_field"]], "path": str(out_wav)})
        job_file = tmp / "jobs.json"
        job_file.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")

        culture_pattern = cfg["sapi_culture"]
        job_file_ps = str(job_file).replace("'", "''")
        ps_script = f"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object {{ $_.Enabled -and $_.VoiceInfo.Culture.Name -like '{culture_pattern}' }} | Select-Object -First 1
if (-not $voice) {{
  $voice = $synth.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Culture.Name -like '{culture_pattern}' }} | Select-Object -First 1
}}
if ($voice) {{ $synth.SelectVoice($voice.VoiceInfo.Name) }}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$jobs = Get-Content -Raw -Encoding UTF8 '{job_file_ps}' | ConvertFrom-Json
foreach ($j in $jobs) {{
  $synth.SetOutputToWaveFile($j.path, $fmt)
  $synth.Speak($j.text)
  $synth.SetOutputToNull()
}}
$synth.Dispose()
"""
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"SAPI generation failed: {proc.stderr.strip()}")

        for j in jobs:
            raw = pathlib.Path(j["path"]).read_bytes()
            results[j["id"]] = {
                "mime": "audio/wav",
                "data": base64.b64encode(raw).decode("ascii"),
                "bytes": len(raw),
            }

    return results, "windows-sapi"


def _extract_payload_from_js(raw: str, lang: str) -> dict | None:
    """Extract JSON payload from either v2 (__VOICE_PACKS__.<lang>=) or legacy (__VOICE_PACK__ =) JS."""
    decoder = json.JSONDecoder()
    patterns = [
        rf"window\.__VOICE_PACKS__\.{re.escape(lang)}\s*=\s*",
        r"window\.__VOICE_PACK__\s*=\s*",
    ]
    for pattern in patterns:
        match = re.search(pattern, raw)
        if not match:
            continue
        pos = match.end()
        if pos < len(raw) and raw[pos] == "{":
            try:
                payload, _ = decoder.raw_decode(raw, pos)
                if isinstance(payload, dict):
                    return payload
            except json.JSONDecodeError:
                continue
    return None


def load_existing_reusable_clips(
    output_path: pathlib.Path, manifest: dict, lang: str
) -> tuple[dict[str, dict], str]:
    """Load existing pack clips whose role and language displayText still match manifest."""
    if not output_path.exists():
        return {}, ""
    raw = output_path.read_text(encoding="utf-8")
    payload = _extract_payload_from_js(raw, lang)
    if not payload:
        return {}, ""

    display_field = LANG_CONFIG[lang]["display_field"]
    old_clips = payload.get("clips") or {}
    reusable: dict[str, dict] = {}
    for clip in manifest["clips"]:
        cid = clip["id"]
        old = old_clips.get(cid)
        if not isinstance(old, dict):
            continue
        data = old.get("data") or ""
        if (
            old.get("role") == clip["role"]
            and old.get(display_field) == clip[display_field]
            and len(data) > 200
        ):
            reusable[cid] = {
                "mime": old.get("mime", "audio/mpeg"),
                "data": data,
                "bytes": len(base64.b64decode(data)),
            }
    existing_engine = payload.get("engine") or ""
    return reusable, existing_engine


def write_voice_pack_js(
    output_path: pathlib.Path,
    manifest: dict,
    clip_blobs: dict[str, dict],
    engine_used: str,
    lang: str,
) -> None:
    """Write classic global JS voice pack compatible with file:// and Node vm."""
    sanitized_roles = {}
    for role_name, role_cfg in manifest["roles"].items():
        sanitized_roles[role_name] = {
            "speakerLabel": role_cfg["speakerLabel"],
            "speakerLabelEn": role_cfg["speakerLabelEn"],
            "speechPitch": role_cfg["speechPitch"],
            "speechRate": role_cfg["speechRate"],
        }

    ordered_clips = {}
    total_raw = 0
    for clip in manifest["clips"]:
        cid = clip["id"]
        blob = clip_blobs[cid]
        total_raw += blob["bytes"]
        ordered_clips[cid] = {
            "role": clip["role"],
            "priority": clip["priority"],
            "cooldownSec": clip.get("cooldownSec", 0),
            "displayText": clip["displayText"],
            "displayTextEn": clip["displayTextEn"],
            "mime": blob["mime"],
            "data": blob["data"],
        }

    payload = {
        "version": manifest["version"],
        "lang": lang,
        "engine": engine_used,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "roles": sanitized_roles,
        "clips": ordered_clips,
    }
    payload_json = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    if lang == "zh":
        assignment = (
            "window.__VOICE_PACKS__=window.__VOICE_PACKS__||{};"
            f"window.__VOICE_PACKS__.zh={payload_json};"
            "window.__VOICE_PACK__=window.__VOICE_PACKS__.zh;"
        )
    else:
        assignment = (
            "window.__VOICE_PACKS__=window.__VOICE_PACKS__||{};"
            f"window.__VOICE_PACKS__.en={payload_json};"
        )

    js_body = f"// Auto-generated by scripts/generate_voices.py. Do not edit manually.\n{assignment}\n"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = output_path.with_suffix(".js.tmp")
    tmp_out.write_text(js_body, encoding="utf-8")
    tmp_out.replace(output_path)

    print(
        f"Generated {output_path.relative_to(ROOT_DIR)} [{lang}] using {engine_used}: "
        f"{len(ordered_clips)} clips, {total_raw / 1024:.1f} KB raw audio, "
        f"{output_path.stat().st_size / 1024:.1f} KB JS payload."
    )


def generate_pack_for_lang(
    manifest: dict, lang: str, engine: str, incremental: bool
) -> int:
    """Build voice pack JS for a single language ('zh' or 'en')."""
    output_path = LANG_CONFIG[lang]["output_path"]
    reused_clips: dict[str, dict] = {}
    existing_engine = ""
    pending_clips = list(manifest["clips"])
    if incremental:
        reused_clips, existing_engine = load_existing_reusable_clips(output_path, manifest, lang)
        pending_clips = [c for c in manifest["clips"] if c["id"] not in reused_clips]
        print(
            f"Incremental mode [{lang}]: reusing {len(reused_clips)} clips, "
            f"synthesizing {len(pending_clips)} clips."
        )

    clip_blobs: dict[str, dict] = dict(reused_clips)
    engine_used = existing_engine or ("edge-tts" if reused_clips else "")

    if pending_clips:
        synth_manifest = {**manifest, "clips": pending_clips}
        new_blobs: dict[str, dict] | None = None
        if engine in ("auto", "edge"):
            try:
                import edge_tts  # noqa: F401
                new_blobs, engine_used = asyncio.run(generate_with_edge(synth_manifest, lang))
            except Exception as exc:
                if engine == "edge":
                    print(f"edge-tts generation failed [{lang}]: {exc}", file=sys.stderr)
                    return 1
                print(f"edge-tts unavailable/failed [{lang}] ({exc}); falling back to Windows SAPI...")

        if new_blobs is None:
            new_blobs, engine_used = generate_with_sapi(synth_manifest, lang)
        clip_blobs.update(new_blobs)

    write_voice_pack_js(output_path, manifest, clip_blobs, engine_used, lang)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate dual-language voice packs from manifest.")
    parser.add_argument(
        "--lang",
        choices=("zh", "en", "all"),
        default="all",
        help="Target language pack to generate: zh, en, or all (default: all).",
    )
    parser.add_argument(
        "--engine",
        choices=("auto", "edge", "sapi"),
        default="auto",
        help="TTS backend to use.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate voice_manifest.json (both ZH and EN fields) without generating audio.",
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Reuse matching clips already present in each output JS file and synthesize only new/changed clips.",
    )
    args = parser.parse_args()

    manifest = load_and_validate_manifest(MANIFEST_PATH)
    print(
        f"Manifest OK (v{manifest['version']}): {len(manifest['clips'])} clips, "
        f"{len(manifest['roles'])} roles (ZH + EN validated)."
    )
    if args.check:
        return 0

    target_langs = ["zh", "en"] if args.lang == "all" else [args.lang]
    for lang in target_langs:
        rc = generate_pack_for_lang(manifest, lang, args.engine, args.incremental)
        if rc != 0:
            return rc
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
