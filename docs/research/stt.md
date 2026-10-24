# Research brief: stt (2026-10-21)

## Recommendation

For v0, record in the browser with MediaRecorder (prefer audio/webm;codecs=opus, fall back to audio/mp4). Upload the blob to your server, convert it with ffmpeg to 16 kHz mono WAV, and transcribe with OpenAI `gpt-transcribe`: POST https://api.openai.com/v1/audio/transcriptions with model=gpt-transcribe, languages[]=zh and languages[]=en, keywords[] built from family names and places, and a short context prompt in Simplified Chinese. It costs $0.0045/min, which is about $1–2/month for one family. Run OpenCC t2s on the output so it is always Simplified. The fallback is Alibaba's Qwen3-ASR-Flash (Singapore/international region, about $0.0021/min, one JSON POST with a base64 data URL). It also becomes the default if a week-1 test of about 30 real family clips shows clearly better Mandarin, or if the grandparents speak a dialect. The Qwen3-ASR paper (written by Alibaba, so possibly biased) shows GPT-4o-transcribe doing much worse on conversational and elderly Mandarin, and OpenAI has published no Mandarin numbers for gpt-transcribe. Do not build on the Web Speech API: it is missing or fails silently in iOS home-screen apps. The phone keyboard's dictation button in the text box is the free fallback. ffmpeg is not strictly needed for Android webm/opus, but it is recommended for iPhone recordings (Safari MP4s have a history of being rejected by OpenAI). It is also needed for Qwen, whose docs confirm only WAV and MP3, and for any self-hosted model. So run it on every upload.

# Speech-to-text for family_share: short Mandarin+English voice notes (as of 2026-10-21)

## 0. TL;DR architecture

```
[PWA hold-to-talk] --MediaRecorder blob (webm/opus or mp4/aac)--> POST /api/voice (multipart)
   -> save original (debug/archive)
   -> ffmpeg -> 16 kHz mono PCM WAV  (works with every provider and local model)
   -> STT adapter: primary = OpenAI gpt-transcribe; fallback = Alibaba qwen3-asr-flash (Singapore)
   -> OpenCC t2s (force Simplified) -> store utterance -> Claude interpreter -> reply to client with transcript (editable)
Zero-cost path: user taps the keyboard mic in the chat textarea (iOS Dictation / Gboard / WeChat / iFlytek / Sogou keyboards) -> text goes through the same Claude path.
```

Volume estimate: 4 users × 15 notes/day × 10 s ≈ 300 min/month. That is about $1.35/month on gpt-transcribe, about $0.63 on Qwen3-ASR-Flash, and about $0.50 on Soniox. Cost is irrelevant at this scale. Choose for Mandarin quality, simplicity and account friction.

---

## 1. Browser capture

### 1.1 MediaRecorder formats (2026)
| Platform | `isTypeSupported('audio/webm;codecs=opus')` | `audio/mp4` (AAC) | Default when no mimeType passed |
|---|---|---|---|
| iOS Safari 18.4+ (incl. iOS 26/27, also home-screen web apps, which use the same WebKit) | **true**. WebKit: "MediaRecorder in WebKit for Safari 18.4 now supports creating WebM files using the Opus audio codec". | true (fragmented MP4 / ISOBMFF; ALAC/PCM also possible) | audio/mp4 (AAC). This is historical behaviour, so log `recorder.mimeType` to confirm. |
| iOS ≤ 18.3 | false | true | audio/mp4 |
| Android Chrome | true | true since Chrome 126 (MP4 muxer: Opus or AAC) | audio/webm;codecs=opus |

Notes:
- Ogg/Opus recording still fails on Safari 18.4 (frequal.com test). Don't use `audio/ogg`.
- iOS 18.4 rewrote MediaRecorder internals. An MP4 + repeated `requestData()` race crashed in 18.4 beta 3 and was fixed in beta 4 (WebKit 290002). Avoid aggressive timeslices on iOS.
- Always pass an explicit mimeType chosen with `isTypeSupported`. Build the Blob with `recorder.mimeType`, and give the upload a filename whose extension matches (`.webm` / `.m4a`).

Recommended client code:
```js
const CANDIDATES = ['audio/webm;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/webm'];
const pickMime = () => CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
let stream = null;
async function getMic() {
  if (stream?.getAudioTracks().some(t => t.readyState === 'live')) return stream;
  stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); // do NOT force sampleRate
  return stream;
}
async function startHold() {
  const s = await getMic();
  const mimeType = pickMime();
  const rec = new MediaRecorder(s, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 });
  const chunks = []; const t0 = performance.now();
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || mimeType || 'audio/mp4';
    const ms = performance.now() - t0;
    if (ms < 600) return;                       // discard accidental taps
    const ext = type.includes('webm') ? 'webm' : 'm4a';
    const fd = new FormData();
    fd.append('audio', new Blob(chunks, { type }), `note.${ext}`);
    fd.append('durationMs', String(Math.round(ms)));
    fetch('/api/voice', { method: 'POST', body: fd });
  };
  rec.start();                                   // no timeslice needed for <=60 s clips
  return rec;
}
// release mic (removes the orange indicator and restores iOS audio routing):
function releaseMic(){ stream?.getTracks().forEach(t => t.stop()); stream = null; }
document.addEventListener('visibilitychange', () => document.hidden && releaseMic());
```
Hold-to-talk UX:
- Use `pointerdown` with `setPointerCapture`, and stop on `pointerup`/`pointercancel`.
- CSS: `touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none`.
- Auto-stop at 60 s.
- Copy WeChat's familiar "按住说话 / 上滑取消" (hold to talk / slide up to cancel) gesture.
- Only show "recording" after `rec.onstart`, so the user doesn't clip the first syllable.
- Settings: Opus at 24–32 kbps is plenty for speech (30 s ≈ 120 KB). Safari may ignore `audioBitsPerSecond` for AAC, which is harmless.
- HTTPS is mandatory: getUserMedia needs a secure context, and so does the PWA itself.

### 1.2 Mic permission in an iOS home-screen web app
- **Current behaviour: a prompt on each cold launch.** WebKit bug 327237 (filed 2026-10-12, NEW, untriaged, rdar://189868738) was reported on iOS 26.6.2: "Home Screen web apps ask for camera/microphone permission again on every launch, with no way to keep it persistent". Bug 215884 covered the older hash-navigation resets; it was closed "configuration changed", and reports of non-persistence continued through iOS 18.5.
- Within one running session, a second getUserMedia normally doesn't re-prompt. Avoid hash-only route changes, which historically reset it. Verify both on device.
- Workaround: set Settings → Apps → Safari → Microphone → Allow. This applies to all sites, and the bug reporter calls it the only workaround. iOS keeps PWAs suspended in memory, so true cold launches happen less often than app opens.
- Design: request the mic on the first press of each launch. Show a one-line explainer before the first prompt.
- Trade-off: keeping the stream open for the whole session avoids prompts and clipping, but leaves the orange mic dot on and can duck or route audio playback. Recommendation: release it after each note or on hide, and accept a prompt per cold launch.
- **Android Chrome / installed WebAPK:** the permission persists per origin after "Allow while visiting the site". The OS-level mic permission for Chrome must also be on.

### 1.3 Web Speech API (SpeechRecognition): do not use for v0
- **iOS home-screen web app: unusable.** A WebKit engineer said in bug 225298 (closed RESOLVED LATER, no fix since) that it "is not available in SafariViewController and web apps added to Home Screen". 2026 reports (polyglotte issue #65, Oct 2026) describe a silent failure: `webkitSpeechRecognition` exists and `start()` succeeds, but `onresult` never fires. WebKit 321436 (iOS 26/27) is a related hang after media playback. Feature detection cannot catch any of this. iOS Safari in a normal tab works only with Siri/Dictation enabled.
- **Android Chrome:** works for `zh-CN` and supports interim results. It uses Google's servers, so it needs network. `continuous=true` is flaky on Android (it stops after silence, and duplicated results have been reported). Chrome has on-device `processLocally` / `SpeechRecognition.available()` / `install()`, but Android availability is unverified.
- **Conclusion:** one MediaRecorder + server STT path on both platforms. The Web Speech API could at most be an optional live-preview on Android later.

### 1.4 Zero-cost fallback: keyboard dictation
- Keep the chat input a normal `<textarea>` so the keyboard mic works. Tag these utterances `source='keyboard'`.
- **iOS Dictation:** enable it in Settings → General → Keyboard. It follows the active keyboard language (add Chinese Simplified Pinyin). It handles Mandarin with occasional English words.
- **Gboard:** voice typing supports Mandarin (China) and has offline packs.
- **WeChat Keyboard (微信输入法, Tencent):** listed on the US App Store. Voice input with no long-press, offline voice, 15 dialects, improving Chinese–English mixing.
- **iFlytek (讯飞输入法):** markets mixed Chinese–English voice input with no switching, plus offline voice.
- **Sogou / Doubao (豆包输入法, iOS since Nov 2025, advertises 中英混输, mixed Chinese–English):** strong for mixed speech.
- Caveats: third-party keyboards need "Allow Full Access" on iOS and send audio to Chinese servers. Android builds of Sogou, iFlytek and WeChat Keyboard may not be on Google Play outside China (unverified).

---

## 2. Hosted STT APIs (Oct 2026)

| Provider / model | Mandarin + English code-switching | Price | Integration | Notes |
|---|---|---|---|---|
| **OpenAI `gpt-transcribe`** (released 2026-07-28; recommended model) | Yes: `languages` (multiple hints), `keywords`, `prompt`. The model page explicitly cites code-switching. Response returns detected `languages`. | **$0.0045/min** | One multipart POST | 25 MB max. Formats (SDK): flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. Streaming via `stream=true`. Default rate limits are 5,000 RPM at the lowest (Build) tier. No published Mandarin WER. Script (Simplified/Traditional) is not documented. |
| OpenAI legacy: `gpt-4o-transcribe` ($0.006), `gpt-4o-mini-transcribe` ($0.003), `whisper-1` ($0.006), `gpt-4o-transcribe-diarize` | prompt only | – | same endpoint | **All shut down on 2027-02-26** (deprecation notice 2026-08-26). Don't start on them. |
| OpenAI `gpt-live-transcribe` / `gpt-realtime-whisper` | streaming | $0.017/min | Realtime WS/WebRTC, PCM 24 kHz | `delay`: minimal…xhigh. Live captions while holding would be a v1 upgrade. |
| **Alibaba Model Studio / QwenCloud `qwen3-asr-flash`** (Singapore/intl) | Mixed audio is supported: leave `language` unset. Chinese dialects (Sichuanese, Minnan, Wu), Cantonese, English, plus about 25 more languages. Context via a system message. | **$0.000035/s ≈ $0.0021/min** (intl); 100 RPM | One JSON POST (OpenAI-compatible chat/completions, audio as a data URL) | 10 MB (after base64) and 5 min max. Documented formats are only WAV/MP3, so transcode. Optional ITN (zh/en). Returns emotion annotations. No free quota outside Beijing for this model; the new-user quota terms are unclear. The newer `qwen-audio-3.1-asr-flash` (DashScope native, 600 RPM, token-priced) is also available. |
| **Soniox** `stt-async-v5` / `stt-rt-v5` | Strong vendor claims: automatic switching between Chinese and English mid-utterance, language ID per token. Self-reported Chinese WER 1.25% vs OpenAI 3.24%. | ~$0.10/h async (~$0.0017/min), ~$0.12/h real-time | Async is 3 steps (POST /v1/files → POST /v1/transcriptions → poll GET → GET …/transcript). Real-time is `wss://stt-rt.soniox.com/transcribe-websocket`. | Formats include webm, ogg, m4a, mp4, wav, aac. A good third bake-off candidate. Polling adds latency. Server-side, a one-shot WebSocket (config with `audio_format:"auto"`, `language_hints:["zh","en"]`) is faster. |
| Deepgram Nova-3 | **No.** `language=multi` covers only en, es, fr, de, hi, ru, pt, ja, it, nl. Chinese is monolingual only (`zh`/`zh-CN`/`zh-Hans`; `zh-TW`/`zh-Hant`; `zh-HK` = Cantonese), so English words inside Mandarin suffer. | Pre-recorded $0.0043/min mono (PAYG); streaming $0.0048 (promo); $200 free credit | `POST https://api.deepgram.com/v1/listen?model=nova-3&language=zh-CN&smart_format=true`, `Authorization: Token <key>`, raw body | Not recommended for this family. Its advantage is explicit Simplified vs Traditional codes. |
| ElevenLabs Scribe v2 | Mandarin is in the "High Accuracy" tier (>5–10% WER). Code-switching is not documented. | $0.22/h (~$0.0037/min); keyterms +$0.05/h | `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key`, multipart `model_id=scribe_v2`, `file`, `language_code`, `keyterms` (≤1000) | Accepts all common formats (webm, m4a, mp4, opus). Response: `language_code`, `text`, `words[]`. |
| Google Gemini 3.5 Transcribe (public preview since 2026-08-26) | Yes: auto-detection across 85+ languages, code-switching, `cmn-Hans-CN` (Simplified Mandarin listed; Traditional Mandarin is not). Custom vocabulary ≤1000 terms. | Paid tier ≈ $0.003/min audio in + ≈ $0.002/min text out. **The free tier uses data to improve Google products.** | `POST https://generativelanguage.googleapis.com/v1beta/interactions`, `x-goog-api-key`, Files API upload, `generation_config.transcription_config.language_codes` | Preview status, model IDs are inconsistent across docs (`gemini-3.5-transcribe` vs `-preview`), Files-API upload step. Not for v0. |
| Google Cloud STT V2 Chirp 3 | Auto language detection | ~$0.016/min (unverified) | Service-account auth, recognizers | Heavier setup, superseded by Gemini 3.5 Transcribe. |
| Mistral Voxtral Mini Transcribe V2 | Chinese is among its 13 languages; code-switching unverified | $0.003/min batch, $0.006 real-time; open weights | – | Possible extra candidate. |
| Newcomers in Soniox's Sep-2026 price table: xAI `grok-voice-transcribe-2.0` ($0.10/h async), Meta `muse-voice-transcribe-1.0`, Inworld, Smallest Pulse, AssemblyAI Universal-3.5 Pro, ByteDance Seed-ASR 2.0 (BytePlus; strong Mandarin and dialects, no USD price found) | Chinese quality unverified | – | – | Ignore for v0. |

**Mandarin quality evidence (self-reported by the Qwen3-ASR authors, arXiv 2601.21337; CER %, lower is better):**

| Test set | GPT-4o-transcribe | Gemini-2.5-Pro | Doubao-ASR | Whisper-large-v3 | Qwen3-ASR-0.6B | Qwen3-ASR-1.7B |
|---|---|---|---|---|---|---|
| WenetSpeech net / meeting | 15.30 / 32.27 | – | – | 9.86 / 19.11 | 5.97 / 6.88 | 4.97 / 5.88 |
| Elders&Kids | 14.27 | 36.93 | 4.17 | 10.61 | 4.48 | 3.81 |
| Dialog-Mandarin | 20.73 | – | 6.61 | 14.01 | 7.06 | 6.54 |
| Fleurs-zh | 2.44 | – | – | 4.09 | 2.88 | 2.41 |

(The "–" cells are numbers not extracted for this brief, not missing from the paper.) These numbers predate gpt-transcribe. OpenAI claims gpt-transcribe roughly halves whisper-1's WER on a 22-language benchmark (40.37% → 19.27%), but gives no zh breakdown. **Hence the week-1 test on real family clips.**

**Simplified vs Traditional:**
- Deepgram: chosen by language code.
- Gemini: only `cmn-Hans-CN` listed.
- OpenAI, Alibaba, Soniox and ElevenLabs: not documented. Whisper-family models are known to mix scripts.
- Mitigation: put a context prompt written in Simplified Chinese, and always apply **OpenCC t2s** server-side (`opencc-js`: `OpenCC.Converter({from:'tw',to:'cn'})`; Python: `OpenCC('t2s')`). It doesn't touch English. Make it a per-user setting in case a Cantonese-speaking grandparent wants Traditional.

**Punctuation:** OpenAI, Qwen3-ASR-Flash, ElevenLabs and Soniox all return punctuated text. Deepgram needs `smart_format`/`punctuate`. Self-hosted SenseVoice needs `use_itn=True`. Paraformer needs a separate punctuation model.

---

## 3. Self-hosting (optional, later: privacy/offline)

| Model | Size / license | Langs | Speed (reported) | Fit |
|---|---|---|---|---|
| **Qwen3-ASR-0.6B / 1.7B** (open-sourced 2026-01-29) | Apache-2.0 | 30 languages + 22 Chinese dialects; best open Mandarin in its report | MLX on Apple M5 Pro: RTF 0.012–0.015 (0.6B, 4–5-bit) and 0.027–0.033 (1.7B), so a 10 s clip takes about 0.15–0.35 s. Peak RAM about 1–2 GB. M4 Max: about 22–30× real-time on long Chinese audio. | Best self-host choice on an Apple Silicon Mac: `mlx-audio` or `moona3k/mlx-qwen3-asr`. On a GPU box: `pip install qwen-asr[vllm]`, then `qwen-asr-serve Qwen/Qwen3-ASR-0.6B`, which exposes OpenAI-compatible `/v1/chat/completions` and transcriptions. CPU-VPS speed is unverified. |
| **SenseVoiceSmall** (FunASR) | 234M; code MIT, weights under the FunASR model license (commercial use permitted) | zh, en, yue, ja, ko | Non-autoregressive. FunASR reports about 17× real-time on CPU and 170× on GPU; Chinese CER 7.81% on its 184-file benchmark vs Whisper-large-v3 at 20.02%. Inputs up to 30 s per call. | Best choice for a small CPU VPS (2–4 vCPU). `funasr-server` exposes an OpenAI-compatible `/v1/audio/transcriptions` (keep it on loopback). Also runs via sherpa-onnx or GGUF/llama.cpp. Strip the `<\|zh\|><\|NEUTRAL\|>…` tags with `rich_transcription_postprocess`. |
| Fun-ASR-Nano-2512 | 800M | zh, en, ja + dialects | GGUF on CPU: 8.3% CER on that 184-clip benchmark vs whisper.cpp 22–31% | GPU preferred. CPU via GGUF. |
| whisper.cpp large-v3-turbo | MIT | 99 languages | Metal on M-series: several × real-time (14–18× on M5-class, per one commercial site) | Easiest to run, but weakest Chinese of these. Mixes Traditional characters (prompt `以下是普通话的句子。` plus OpenCC), and hallucinates on silence. |

Recommendation: stay hosted for v0. Keep the adapter interface so `local-qwen3-asr` (Mac) or `local-sensevoice` (VPS) can be added as a third provider.

---

## 4. Recommended v0 implementation

### 4.1 Server pipeline
1. `POST /api/voice` (multipart `audio`, `durationMs`). Reject if larger than 5 MB or longer than 90 s. Save the original to `data/voice/<uuid>.<ext>`.
2. Normalize with ffmpeg. **Write to a temp file first**: MP4 from stdin can fail if non-seekable.
   `ffmpeg -nostdin -hide_banner -loglevel error -i in.<ext> -vn -ac 1 -ar 16000 -c:a pcm_s16le -f wav out.wav`
   It takes about 50 ms and produces about 32 KB/s (30 s ≈ 960 KB). Optionally run `-af volumedetect` and skip STT if the clip is near-silent (avoids hallucinations).
3. Call the primary STT (15 s timeout, one retry on 429/5xx). On failure, call the fallback. If both fail, keep the audio, mark the utterance `stt_failed`, and show "重试" (retry). Never lose audio.
4. Run OpenCC t2s, store the result, send the text to Claude, and return `{utteranceId, text}` to the client. Show the transcript and let the user edit it before or after the task operation.
5. Table `utterances`: id, user_id, source (voice|keyboard|text), audio_path, mime, duration_ms, stt_provider, stt_model, text_raw, text, detected_languages, stt_latency_ms, created_at. Use this table for the bake-off.

**Is ffmpeg needed?**
- Android Chrome webm/opus goes to OpenAI fine as-is.
- iPhone: Safari MP4/AAC uploads have repeatedly been rejected by OpenAI with "Invalid file format" (2023–2024 forum threads; an `ffmpeg -c copy` remux fixes it). WebM from iOS 18.4+ is newer and less proven.
- Qwen documents only WAV/MP3, and every local model wants 16 kHz PCM.
- So run ffmpeg on every upload. This also makes swapping providers a config change.

### 4.2 Primary: OpenAI gpt-transcribe
```
POST https://api.openai.com/v1/audio/transcriptions
Authorization: Bearer $OPENAI_API_KEY
Content-Type: multipart/form-data
  file=@note.wav;type=audio/wav        # extension-bearing filename + content type recommended
  model=gpt-transcribe
  languages[]=zh                       # ISO-639-1; replaces `language` (never send both)
  languages[]=en
  keywords[]=Costco                    # one literal term per part; no < > CR LF; invalid -> whole request fails
  keywords[]=小明
  prompt=一家人用普通话夹杂英文商量家务、购物和日程的语音留言。   # scene context, Simplified Chinese
  response_format=json                 # optional; stream=true gives SSE transcript.text.delta / transcript.text.done
```
Array fields use the bracket form (`languages[]`), the same encoding the official Python SDK sends. In the Python SDK, older versions pass `languages`/`keywords` via `extra_body`; current versions accept them directly.

Response:
```json
{ "text": "明天下午三点带Emily去看dentist，顺便去Costco买牛奶。",
  "languages": [{"code":"zh"},{"code":"en"}],
  "usage": {"type":"duration","seconds":9.8} }
```
(`languages: []` means detection was not reliable. `usage` may be the tokens variant: `input_tokens`/`output_tokens`/`total_tokens`.)

Node:
```js
const fd = new FormData();
fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'note.wav');
fd.append('model', 'gpt-transcribe');
['zh','en'].forEach(l => fd.append('languages[]', l));
keywords.forEach(k => fd.append('keywords[]', k));          // names, schools, stores, pets (~<=100)
fd.append('prompt', '一家人用普通话夹杂英文商量家务、购物和日程的语音留言。');
const r = await fetch('https://api.openai.com/v1/audio/transcriptions',
  { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: fd,
    signal: AbortSignal.timeout(15000) });
const { text, languages } = await r.json();
```

### 4.3 Fallback (and promotion candidate): Alibaba qwen3-asr-flash, Singapore
```
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions
     (legacy, still works: https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions)
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
{
  "model": "qwen3-asr-flash",
  "messages": [
    {"role": "system", "content": [{"text": "家庭成员：小明、Emily、外婆；常去：Costco、Trader Joe's、Facebook Marketplace"}]},
    {"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": "data:audio/wav;base64,<...>"}}]}
  ],
  "stream": false,
  "asr_options": { "enable_itn": true }      // omit "language" for mixed zh/en; set "zh" only if purely Mandarin
}
```
- Response: `choices[0].message.content` is the transcript string. `annotations[].emotion` is optional.
- Limits: 10 MB after base64 (30 s of 16 kHz WAV ≈ 1.3 MB base64), 5 min, 100 RPM.
- With the OpenAI SDK, pass `asr_options` in `extra_body` (Python) or as a top-level field (Node).
- Account: Alibaba Cloud International main account (email/phone; GitHub login on QwenCloud), Singapore region. International pages are now branded "QwenCloud" (home.qwencloud.com).

### 4.4 Week-1 test
- Collect about 30 real clips: each speaker, kitchen noise, grandparents, English nouns.
- Run gpt-transcribe, qwen3-asr-flash and Soniox offline from the saved WAVs.
- Hand-score character errors, plus whether names, times and English nouns survive.
- Promote Qwen if it is clearly better, or if a grandparent speaks a dialect (Qwen covers 22 dialects).

## 5. Risks
- **iOS mic prompt on each cold launch** (WebKit 327237, open). Mitigate with UX copy and the global Safari mic "Allow" setting.
- **Unpublished OpenAI Mandarin quality and script output.** Mitigate with the test, OpenCC, and a Simplified-Chinese prompt.
- **Provider churn.** OpenAI retires all older STT models on 2027-02-26. Alibaba is rebranding (domains are moving to workspace URLs and QwenCloud). Keep the adapter thin and the model IDs in config.
- **Short or silent clips cause hallucinations.** Use the minimum-duration and silence check.
- **Privacy.** Family audio goes to OpenAI (API data is not used for training by default) or Alibaba (Singapore). Never use the Gemini free tier, because it trains on your data.
- **Self-hosted HTTPS** is required for getUserMedia and the PWA.

## Unverified

- gpt-transcribe Mandarin accuracy: OpenAI publishes no Chinese WER/CER; the 40.37%→19.27% figure (22-language Common Voice vs whisper-1) comes from secondary coverage of the launch
- Whether gpt-transcribe returns Simplified vs Traditional Chinese reliably (not documented); OpenCC recommended regardless
- Whether gpt-transcribe accepts iOS Safari MediaRecorder MP4/WebM uploads directly without remux (historic 'Invalid file format' reports were for whisper-1 in 2023-2024)
- gpt-transcribe language codes beyond ISO-639-1 (zh-cn, zh-tw, cmn, yue are claimed only by a third-party guide); no documented limit on keyword count or prompt length
- gpt-transcribe usage object variant (duration vs tokens) and actual end-to-end latency for 2-30 s clips
- Safari's default MediaRecorder mimeType when none is passed (assumed audio/mp4); Chrome default assumed audio/webm;codecs=opus
- iOS home-screen web app mic permission: re-prompt per cold launch is from WebKit bug 327237 (filed 2026-10-12, untriaged); whether calling getUserMedia again within one session re-prompts was not tested on device
- Web Speech API in iOS standalone mode: reports conflict (never fires vs works until media playback); Android Chrome on-device processLocally availability and current continuous-mode duplicate-result bug status
- qwen3-asr-flash supported containers beyond WAV/MP3 (webm/m4a/opus not documented), its Chinese-English code-switching quality, output script, and the exact system-message context format in OpenAI-compatible mode
- Alibaba Cloud International / QwenCloud sign-up requirements (credit card, ID verification) and free quota for qwen3-asr-flash in Singapore
- Qwen3-ASR paper benchmarks (including GPT-4o-transcribe's poor conversational Mandarin numbers) are self-reported by Alibaba
- Soniox Chinese WER claims (1.25% vs OpenAI 3.24%) are vendor self-reported; async latency not documented; whether real-time WS accepts mp4
- ElevenLabs Scribe v2 code-switching behaviour and Chinese script output not documented
- Gemini 3.5 Transcribe exact model IDs (docs show both gemini-3.5-transcribe and -preview suffixes) and per-minute prices (Google's own estimates)
- Google Cloud Chirp 3 price (~$0.016/min from OpenRouter, official pricing page not readable)
- Chinese quality of newcomers xAI grok-voice-transcribe-2.0, Meta muse-voice-transcribe-1.0, Inworld, Voxtral (code-switching), and BytePlus Seed-ASR USD pricing
- Self-host speed figures are from M5 Pro / M4 Max (soniqo, OminiX) and FunASR's unspecified CPU; no M1/M2 or small-VPS CPU numbers for Qwen3-ASR; SenseVoice '70 ms per 10 s' latency not confirmed on the repo page
- Availability of Sogou/iFlytek/WeChat Keyboard Android builds on Google Play outside China; quality of iOS Dictation and Gboard on Mandarin+English code-switching
- Deepgram nova-3 keyterm prompting support for zh

## Sources

- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/models/gpt-transcribe
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/transcription_create_params.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/audio/transcription.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/_base_client.py
- https://spokenly.app/blog/gpt-transcribe
- https://explainx.ai/blog/openai-gpt-live-transcribe-gpt-transcribe-july-2026
- https://www.developersdigest.tech/blog/whisper-1-gpt-4o-transcribe-deprecation
- https://community.openai.com/t/can-t-get-the-right-audio-format-for-recording-in-web-application-with-whisper-on-ios/1025933
- https://community.openai.com/t/invalid-file-format-for-ios-recording/540563
- https://developers.deepgram.com/docs/models-languages-overview
- https://developers.deepgram.com/changelog/2026/3/31
- https://deepgram.com/pricing
- https://community.livekit.io/t/docs-clarify-which-languages-multi-mode-supports-for-deepgram-models/1850
- https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- https://elevenlabs.io/pricing/api
- https://soniox.com/compare/stt/pricing
- https://soniox.com/pricing
- https://soniox.com/docs/stt/async/async-transcription
- https://soniox.com/docs/stt/rt/real-time-transcription
- https://soniox.com/compare-stt/soniox-vs-openai/chinese
- https://www.alibabacloud.com/help/en/model-studio/qwen3-asr-flash
- https://www.alibabacloud.com/help/en/model-studio/qwen-audio-3-1-asr-flash
- https://www.alibabacloud.com/help/en/model-studio/qwen-speech-recognition
- https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
- https://www.alibabacloud.com/help/en/model-studio/new-free-quota.md
- https://www.qwencloud.com/models/qwen3-asr-flash
- https://docs.litellm.ai/docs/providers/qwencloud
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe
- https://ai.google.dev/gemini-api/docs/transcribe
- https://ai.google.dev/gemini-api/docs/pricing
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5-transcribe/
- https://openrouter.ai/google/chirp-3
- https://mistral.ai/news/voxtral-transcribe-2
- https://the-decoder.com/voxtral-transcribe-2-offers-speech-recognition-at-0-003-per-minute/
- https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- https://bugs.webkit.org/show_bug.cgi?id=290002
- https://frequal.com/java/OggOpusStillNotWorkingInSafari18_4.html
- https://media-codings.com/articles/recording-cross-browser-compatible-media
- https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/muxers/README.md
- https://blog.addpipe.com/mediarecorder-api
- https://bugs.webkit.org/show_bug.cgi?id=215884
- https://bugs.webkit.org/show_bug.cgi?id=327237
- https://bugs.webkit.org/show_bug.cgi?id=225298
- https://bugs.webkit.org/show_bug.cgi?id=321436
- https://github.com/JacquesBLR/polyglotte/issues/65
- https://github.com/megulus/practice-journal/pull/338
- https://github.com/anirudhlath/alfred/issues/100
- https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally
- https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static
- https://lists.w3.org/Archives/Public/public-speech-api/2018Feb/0001.html
- https://arxiv.org/html/2601.21337
- https://huggingface.co/Qwen/Qwen3-ASR-0.6B
- https://soniqo.audio/benchmarks/qwen3-asr-vs-whisper
- https://www.mintlify.com/OminiX-ai/OminiX-MLX/asr/qwen3-asr
- https://github.com/moona3k/mlx-qwen3-asr/
- https://github.com/FunAudioLLM/SenseVoice
- https://github.com/modelscope/FunASR
- https://huggingface.co/nile2000/Fun-ASR-Nano-GGUF
- https://www.promptquorum.com/local-llms/apple-silicon-whisper-metal-benchmark
- https://macwhisper.helpscoutdocs.com/article/9-chinese-simplied-and-traditional-troubleshooting
- https://github.com/openai/whisper/discussions/277
- https://www.assemblyai.com/docs/guides/traditional_simplified_chinese
- https://apps.apple.com/us/app/%E5%BE%AE%E4%BF%A1%E8%BE%93%E5%85%A5%E6%B3%95/id1618175312
- https://www.v2ex.com/t/1186631
- https://www.ithome.com/0/692/465.htm
- https://docs.byteplus.com/en/docs/byteplusvoice/asrbilling
