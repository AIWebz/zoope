# zoope

zoope is an AI avatar that goes to your Zoom, Google Meet and Microsoft Teams meetings for you, using your face and voice.

The whole AI engine runs in the browser scripts. It uses no APIs and no servers, and your face and voice stay on your device.

zoope is made for computers (Chrome or Edge on a Mac or PC). On a phone, the app pages show a notice instead.

## Run it

The site has two parts:

- **Marketing site** (`#/`): the landing page, with the meeting-grid hero, how it works, judgement, features and privacy.
- **App** (`#/setup`, `#/clone`, `#/demo`, `#/meetings`): a sidebar layout with a getting-started checklist, in-app dialogs and toasts.

The design system lives in `css/style.css`. It uses neutral zinc tones with one blue accent, 1px borders, and the Geist and Geist Mono typefaces bundled in `vendor/fonts`. The brand wordmark stays in bold Arial.

Open `index.html` through any static server, for example `python3 -m http.server`. Then go to http://localhost:8000. The camera and mic only work on `localhost` or over HTTPS.

## How it works

The face, segmentation, avatar rendering and voice runtimes are bundled in `vendor/`. The only thing fetched from outside is the voice model's weights, once, when you make your voice.

1. **Link** the Zoom, Google Meet or Microsoft Teams accounts you use. zoope saves them; it doesn't sign in.
2. **Names:** zoope asks for your full name, the names and nicknames people call you, and which one to introduce itself with.
3. **Face scan → live avatar:** after a countdown, the bundled MediaPipe Face Landmarker finds 478 points on your face, with depth, and a person segmenter outlines your head, hair and shoulders. `js/portrait.js` turns that camera photo into a live avatar. A depth mesh over the real photo turns, nods and tilts the head, sways a little, blinks, moves the eyes, smiles and breathes, with light sensor grain so it reads as webcam video. While it talks, the jaw follows the voice through a spring (it never snaps), the lips round, spread or close for each sound and get ready for the next sound early, as real lips do (a 20 ms dip in the sound doesn't snap them shut), the lower lip rises to the teeth on "f" and "v", the jaw opens a touch unevenly, and the head nods and the brows lift on stressed words; between sentences it glances away briefly as if thinking.

   **Lip sync from the generated audio:** every 20 ms of the voice zoope is actually playing is analysed. The jaw opens with loudness and with F1 (the first vocal-tract resonance: high in "ah", low in "ee"/"oo"); the lips round when F2 is low and F1 isn't high ("oo", "oh") and spread when F2 is high ("ee"); hiss above 3.5 kHz (s, f, sh) brings the teeth together; silence and stops (m, b, p) close the lips. The lips lead the sound by about 50 ms, as in real speech, and the mouth stays closed whenever no audio is playing. While speaking, the face also smiles a little on warm or upbeat lines (corners, cheeks and lower lids), nods and lifts its brows on stressed syllables; while the AI is writing a reply its eyes drift aside as people's do when thinking; and between turns it blinks, glances, breathes and shifts its posture. With the browser voice, each word is sounded out into visemes (m/b/p close the lips, f/v put the lip to the teeth, and so on), timed from the speech engine's word boundaries.
4. **Voice (two steps):**
   1. **Scan your voice:** read a passage for 15 seconds. zoope measures your typical pitch, pitch range, speaking pace and brightness (timbre), and plots your pitch contour.
   2. **Make your voice:** Kyutai's Pocket TTS, a 100M-parameter neural TTS model with zero-shot voice cloning, encodes that recording and then generates every sentence in your voice. It runs in the browser through onnxruntime-web in a Web Worker, and nothing is uploaded. The weights (~216 MB) download once (from `vendor/models/pocket-tts/en/` if you self-host them, else Hugging Face, else the hf-mirror.com mirror, with retries) and are cached; see `vendor/README.md` to self-host them. If the model can't load, zoope falls back to the browser's voice tuned to your measured pitch and pace, and tells you that it is not your voice.
5. **Notes:** on the Notes page you send zoope background facts, or things to bring up at the next meeting. During a call you can send a live note, and zoope says it at the next pause.
6. **Meetings:** zoope only attends meetings you confirm. Confirmed meetings join automatically at their start time while the page is open.
7. **Summaries:** when a meeting ends, zoope writes a summary on your device: an overview, key points, decisions, action items with owners and due dates, questions waiting on you, and what it said for you. Summaries are saved on the Summaries page, and you can copy them or download them as Markdown.

### Joining real Zoom, Google Meet and Teams calls

zoope uses no platform APIs. The `extension/` folder is a Chrome/Edge extension that drives each platform's own web app:

1. On Setup, click **Download the extension** (`zoope-extension.zip`) and unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the unzipped folder. Setup then shows "Installed". Phone browsers can't run extensions, so real calls are joined from a computer.
2. Add a meeting with its link (a `zoom.us/j/…`, `meet.google.com/…` or `teams.microsoft.com/l/meetup-join/…` link) and approve it.
3. At the start time, or when you click **Join now**, the extension opens the link in a new tab. Zoom links go straight to the Zoom web client. It enters your name, turns on the camera and microphone, and clicks Join. If there's a lobby, it waits there.
4. In that tab, the meeting's camera is your live portrait and its microphone is your voice. The avatar is rendered in the meeting tab, and your voice streams from the zoope tab over a local WebRTC link (with no jitter buffer). The meeting tab measures that link's delay every second and times the avatar's mouth to the voice the meeting actually hears. No server is involved.
5. zoope turns on the meeting's live captions and reads them, with each speaker's name, to decide when to reply. It also opens the meeting chat and forwards every new chat message (sent after it joined) to the zoope tab, where the AI reads it like a spoken line and answers aloud in the meeting. If your neural voice isn't ready, it replies in the meeting chat instead.
6. When the meeting ends, or you click Leave, it leaves the call and writes the summary.

If you host zoope somewhere other than localhost, `*.github.io`, `*.pages.dev`, `*.netlify.app` or `*.vercel.app`, add your site to `bridge.js`'s `matches` in `extension/manifest.json`. After changing `js/portrait.js`, run `extension/build.sh`.

### What zoope says, and what it won't

zoope speaks in the first person as you ("Hi, I'm Alex"). It will not lie about what it is: if someone sincerely asks whether it's a bot or an AI, it says it's your AI avatar speaking from your notes. It shares facts only from your notes, and only when a note clearly matches the question. It never agrees, commits or gives an opinion on your behalf. When it doesn't know something, it says so and passes the question on to you.

### The AI engine (`js/brain.js`, `js/brainworker.js`)

zoope's replies are generated, not picked from templates, by an AI that runs in your browser. When your Chrome has its built-in AI (Gemini Nano, through the Prompt API: recent desktop Chrome with enough disk space and GPU memory), zoope uses it: it is far more capable than the small model zoope can load itself, and nothing is downloaded through zoope. Otherwise a language model runs in your browser through transformers.js: Qwen2.5 0.5B Instruct (4-bit), on WebGPU when your computer has a GPU, otherwise WebAssembly. It is always on: it starts as soon as zoope opens on a computer, and the sidebar shows its status. Its weights download once from Hugging Face (or hf-mirror.com) and are cached; if that fails, zoope retries on its own and uses the rule engine's replies meanwhile. There are no API calls.

The rule engine decides *when* to speak. The model then writes *what* to say, as you, in the moment, from the conversation (the last 14 lines), your notes, your **Personality & style** setting and instructions (Setup), and its general knowledge: answers, small talk, reactions, clarifying questions when something is unclear. It sees everything it has already said and is told not to repeat itself, and a sentence that nearly repeats an earlier one is dropped. Nothing zoope says is scripted: the join greeting, the reply when someone just says your name, and your live notes are all generated too. If the AI engine isn't running, zoope listens but stays quiet (and pings you about questions meant for you) rather than using canned lines. Replies stream: each sentence is spoken as soon as it is generated (the first clause of a long first sentence even sooner), so zoope starts talking almost at once, and turns are kept to three sentences at most. 

**Answering instantly in meetings:** the meeting tab sends what someone has said so far as soon as they pause (a "partial" line), and if zoope would answer it, the AI starts writing the answer right then, held back. When the finished line arrives with the same words, the answer is spoken at once; if they kept talking, it is dropped and redone. (On the CPU model this waits for the finished line, since a dropped answer would hold up the next.) A line ending in a question mark counts as finished after 0.12 s. With Chrome's built-in AI, one session with zoope's instructions is kept loaded all meeting and each reply runs in an instant copy of it, so no reply waits for the model to start. 

Honesty rails: facts about your own work, plans, schedule and numbers may only come from your notes. When they don't cover what you were asked, the model says it will check and get back to them, and zoope pings you. A sentence that claims something personal with a number or name found nowhere in your notes or the conversation is dropped. 

**Installing the AI engine into the extension:** click the zoope icon in Chrome's toolbar and press **Connect**. If Chrome's built-in AI is available (or can be downloaded, which Connect starts), the extension uses it. Otherwise the extension downloads the model into its own storage (using its permission to reach Hugging Face, so the website's download limits don't apply) and runs it in a hidden extension page (`extension/ai.html`). Every zoope tab then sends its replies to that engine instead of loading its own. After a browser restart it starts again from the extension's storage, with no new download. The engine code (`js/aicore.js`) is shared by the website and the extension; `extension/build.sh` packages it with transformers.js into the extension zip.

**Pings:** when zoope can't answer a question meant for you (by name, one-on-one, or right after it spoke), it pings you: a desktop notification, two beeps and a highlighted line saying who asked what. Type an answer in the note box and zoope says it at the next pause. Pings are spaced at least 90 seconds apart, and small talk or questions for others never ping. Everything unanswered is listed in the summary.

### When zoope speaks (`js/engine.js`)

- **Just your name** ("Alex?", "Hey Alex"): zoope answers with a short, generated acknowledgement that invites them to go on. If the same person keeps talking, their next line is treated as meant for you and answered.
- **One-on-one:** with only one other person in the meeting, zoope answers every finished line, not just questions.

Every line said in a meeting gets a score. zoope speaks when the score reaches 0.5 or more.

- It is called by any of your names (spelling mistakes from speech-to-text are tolerated).
- It is asked a question meant for the whole group, and your notes cover the topic.
- It is asked a follow-up about something it just said.
- It is asked a hear-check ("can you hear me?"), an introduction, or the meeting is wrapping up.
- It stays quiet when a question is aimed at someone else, when the speaker hasn't finished their sentence, or when it just spoke and wasn't addressed again.

Requests like "Alex, could you draft the email by Thursday?" become action items. Questions zoope can't answer become follow-ups. If someone is called by a name zoope doesn't know (for example "Hey Jay, …"), the meeting summary asks whether that is one of your names.

"zoope's thinking" under the meeting room shows the score and the reasons for each decision.

### Limits

- **Meetings:** real calls need the extension, and the zoope tab must stay open during the meeting. Platforms change their web apps often. The extension finds buttons by their visible names, but it has only been tested against mock pages, not the live Zoom, Meet and Teams sites, so a platform update can break a step. If captions can't be turned on automatically, turn them on in the meeting yourself. Some hosts block guests or web-client joins. Tell participants an AI avatar is attending, or get their consent, where the law or your workplace requires it.
- **Face:** the live avatar animates one photo, so the head only turns a few degrees. Scan with your mouth closed and in even light for the most natural mouth movement.
- **Voice on phones:** the HD voice (the neural clone) needs about 1 GB of memory, more than most phones give a tab. On phones, and on any device where the HD model can't load, zoope makes a **light voice** instead (`js/litevoice.js`). It uses eSpeak NG (18 MB, WebAssembly) tuned to your scan: it measures the synthesizer at two pitch settings and aims for your median pitch, matches your syllable rate, and builds a filter from your recording's long-term spectrum versus the synthesizer reading the same passage, so it has your tone. It works on every device and in meetings, but it sounds synthetic, not like a recording of you.
- **Voice:** making your voice needs the one-time model download, so the first time needs internet. A zero-shot clone sounds close to you rather than identical, and a quiet room helps. Clone only your own voice, or one you have permission to use.
