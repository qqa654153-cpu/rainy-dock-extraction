#!/usr/bin/env python3
"""
Generate sidecar voice pack (voices/voice_pack.js) from voices/voice_manifest.json.
Supports:
  - edge-tts neural voices (default in auto mode when installed and online)
  - Windows System.Speech (SAPI) offline fallback
  - --check mode for manifest validation
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT_DIR / "voices" / "voice_manifest.json"
OUTPUT_JS_PATH = ROOT_DIR / "voices" / "voice_pack.js"


def load_and_validate_manifest(path: pathlib.Path) -> dict:
    """Load voice manifest and validate schema, roles, and unique non-empty IDs."""
    data = json.loads(path.read_text(encoding="utf-8"))
    roles = data.get("roles") or {}
    clips = data.get("clips") or []
    if not roles or not clips:
        raise ValueError("Manifest must contain non-empty 'roles' and 'clips'.")

    seen_ids: set[str] = set()
    for idx, clip in enumerate(clips):
        cid = (clip.get("id") or "").strip()
        role = (clip.get("role") or "").strip()
        display_text = (clip.get("displayText") or "").strip()
        tts_text = (clip.get("ttsText") or "").strip()
        if not cid:
            raise ValueError(f"Clip at index {idx} is missing 'id'.")
        if cid in seen_ids:
            raise ValueError(f"Duplicate clip id detected: '{cid}'.")
        if role not in roles:
            raise ValueError(f"Clip '{cid}' references unknown role '{role}'.")
        if not display_text or not tts_text:
            raise ValueError(f"Clip '{cid}' must have non-empty displayText and ttsText.")
        seen_ids.add(cid)

    return data


async def synthesize_edge_clip(clip: dict, role_cfg: dict, out_path: pathlib.Path) -> bytes:
    """Synthesize a single MP3 clip using edge-tts."""
    import edge_tts

    communicate = edge_tts.Communicate(
        text=clip["ttsText"],
        voice=role_cfg["edgeVoice"],
        rate=role_cfg.get("rate", "+0%"),
        pitch=role_cfg.get("pitch", "+0Hz"),
    )
    await communicate.save(str(out_path))
    return out_path.read_bytes()


async def generate_with_edge(manifest: dict) -> tuple[dict[str, dict], str]:
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
            out_file = tmp / f"{cid}.mp3"
            async with semaphore:
                raw = await synthesize_edge_clip(clip, role_cfg, out_file)
            results[cid] = {
                "mime": "audio/mpeg",
                "data": base64.b64encode(raw).decode("ascii"),
                "bytes": len(raw),
            }

        await asyncio.gather(*(_worker(c) for c in clips))

    return results, "edge-tts"


def generate_with_sapi(manifest: dict) -> tuple[dict[str, dict], str]:
    """Offline Windows fallback using PowerShell System.Speech."""
    clips = manifest["clips"]
    results: dict[str, dict] = {}

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = pathlib.Path(tmpdir)
        jobs = []
        for clip in clips:
            out_wav = tmp / f"{clip['id']}.wav"
            jobs.append({"id": clip["id"], "text": clip["ttsText"], "path": str(out_wav)})
        job_file = tmp / "jobs.json"
        job_file.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")

        ps_script = f"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zhVoice = $synth.GetInstalledVoices() | Where-Object {{ $_.VoiceInfo.Culture.Name -like 'zh-*' }} | Select-Object -First 1
if ($zhVoice) {{ $synth.SelectVoice($zhVoice.VoiceInfo.Name) }}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$jobs = Get-Content -Raw -Encoding UTF8 '{job_file}' | ConvertFrom-Json
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


def load_existing_reusable_clips(output_path: pathlib.Path, manifest: dict) -> dict[str, dict]:
    """Load existing voice_pack.js clips whose role and displayText still match manifest."""
    if not output_path.exists():
        return {}
    raw = output_path.read_text(encoding="utf-8")
    marker = "window.__VOICE_PACK__ ="
    idx = raw.find(marker)
    if idx < 0:
        return {}
    json_str = raw[idx + len(marker):].strip().rstrip(";")
    try:
        payload = json.loads(json_str)
    except json.JSONDecodeError:
        return {}
    old_clips = payload.get("clips") or {}
    reusable: dict[str, dict] = {}
    for clip in manifest["clips"]:
        cid = clip["id"]
        old = old_clips.get(cid)
        if not old:
            continue
        data = old.get("data") or ""
        if (
            old.get("role") == clip["role"]
            and old.get("displayText") == clip["displayText"]
            and len(data) > 200
        ):
            reusable[cid] = {
                "mime": old.get("mime", "audio/mpeg"),
                "data": data,
                "bytes": len(base64.b64decode(data)),
            }
    return reusable


def write_voice_pack_js(
    output_path: pathlib.Path,
    manifest: dict,
    clip_blobs: dict[str, dict],
    engine_used: str,
) -> None:
    """Write window.__VOICE_PACK__ JS module for zero-CORS file:// loading."""
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
            "mime": blob["mime"],
            "data": blob["data"],
        }

    payload = {
        "version": manifest["version"],
        "engine": engine_used,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "roles": manifest["roles"],
        "clips": ordered_clips,
    }
    js_body = (
        "// Auto-generated by scripts/generate_voices.py. Do not edit manually.\n"
        "window.__VOICE_PACK__ = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_out = output_path.with_suffix(".js.tmp")
    tmp_out.write_text(js_body, encoding="utf-8")
    tmp_out.replace(output_path)

    print(
        f"Generated {output_path.relative_to(ROOT_DIR)} using {engine_used}: "
        f"{len(ordered_clips)} clips, {total_raw / 1024:.1f} KB raw audio, "
        f"{output_path.stat().st_size / 1024:.1f} KB JS payload."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate voice_pack.js from manifest.")
    parser.add_argument(
        "--engine",
        choices=("auto", "edge", "sapi"),
        default="auto",
        help="TTS backend to use.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate voice_manifest.json only without generating audio.",
    )
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Reuse matching clips already present in voices/voice_pack.js and synthesize only new/changed clips.",
    )
    args = parser.parse_args()

    manifest = load_and_validate_manifest(MANIFEST_PATH)
    print(f"Manifest OK: {len(manifest['clips'])} clips, {len(manifest['roles'])} roles.")
    if args.check:
        return 0

    reused_clips: dict[str, dict] = {}
    pending_clips = list(manifest["clips"])
    if args.incremental:
        reused_clips = load_existing_reusable_clips(OUTPUT_JS_PATH, manifest)
        pending_clips = [c for c in manifest["clips"] if c["id"] not in reused_clips]
        print(f"Incremental mode: reusing {len(reused_clips)} clips, synthesizing {len(pending_clips)} clips.")

    clip_blobs: dict[str, dict] = dict(reused_clips)
    engine_used = "edge-tts" if reused_clips else ""

    if pending_clips:
        synth_manifest = {**manifest, "clips": pending_clips}
        new_blobs: dict[str, dict] | None = None
        if args.engine in ("auto", "edge"):
            try:
                import edge_tts  # noqa: F401
                new_blobs, engine_used = asyncio.run(generate_with_edge(synth_manifest))
            except Exception as exc:
                if args.engine == "edge":
                    print(f"edge-tts generation failed: {exc}", file=sys.stderr)
                    return 1
                print(f"edge-tts unavailable/failed ({exc}); falling back to Windows SAPI...")

        if new_blobs is None:
            new_blobs, engine_used = generate_with_sapi(synth_manifest)
        clip_blobs.update(new_blobs)

    write_voice_pack_js(OUTPUT_JS_PATH, manifest, clip_blobs, engine_used)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
