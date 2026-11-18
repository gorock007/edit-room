"""Transcribe the preview's voice with word times, for Edit Room's checks (server/checks.ts).
usage: python3 -I listen.py <audio.wav> [prompt]   ->  one JSON line: {"words": [{"w", "s", "e"}]}
The prompt is the edit's own names (so "Claude" isn't heard as "Cloud"). Whisper is a hint, not proof: it can skip a
repeated word or invent one, which is why the checks only say "listen here".
"""
import json, sys

try:
    import whisper
except Exception as e:  # not installed: the checks say so and carry on without the listening pass
    print(json.dumps({"error": f"whisper is not installed ({e})"}))
    sys.exit(3)

wav = sys.argv[1]
prompt = sys.argv[2] if len(sys.argv) > 2 else ""
model = whisper.load_model("large-v3-turbo")
r = model.transcribe(wav, language="en", word_timestamps=True, condition_on_previous_text=False, initial_prompt=prompt or None)
words = [{"w": x["word"].strip(), "s": round(x["start"], 3), "e": round(x["end"], 3)} for s in r["segments"] for x in s.get("words", [])]
print(json.dumps({"words": words}))
