# zoope

zoope is an AI avatar that goes to your Zoom, Google Meet and Microsoft Teams meetings for you, using your face and voice.

The whole AI engine runs in the browser scripts. It uses no APIs and no servers, and your face and voice stay on your device.

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
3. **Face scan → live avatar:** after a countdown, the bundled MediaPipe Face Landmarker finds 478 points on your face, with depth, and a person segmenter outlines your head, hair and shoulders. `js/portrait.js` turns that camera photo into a live avatar. A depth mesh over the real photo turns, nods and tilts the head slightly, blinks, moves the eyes and breathes, with light sensor grain so it reads as webcam video.

   **Lip sync by sound:** the mouth takes the shape of each sound, not just its volume. With your neural voice, every 20 ms of audio is measured: loudness opens the jaw, hiss (s, f, sh) shows the teeth, and where the energy sits in the spectrum separates rounded vowels ("oo", "oh": lips pulled in and pursed) from spread ones ("ee": lips widened, corners up). With the browser voice, each word is sounded out into visemes (m/b/p close the lips, f/v put the lip to the teeth, and so on), timed from the speech engine's word boundaries.
4. **Voice (two steps):**
   1. **Scan your voice:** read a passage for 15 seconds. zoope measures your typical pitch, pitch range, speaking pace and brightness (timbre), and plots your pitch contour.
   2. **Make your voice:** Kyutai's Pocket TTS, a 100M-parameter neural TTS model with zero-shot voice cloning, encodes that recording and then generates every sentence in your voice. It runs in the browser through onnxruntime-web in a Web Worker, and nothing is uploaded. The weights (~216 MB) download once from Hugging Face and are cached; see `vendor/README.md` to self-host them. If the model can't load, zoope falls back to the browser's voice tuned to your measured pitch and pace, and tells you that it is not your voice.
5. **Notes:** on the Notes page you send zoope background facts, or things to bring up at the next meeting. During a call you can send a live note, and zoope says it at the next pause.
6. **Meetings:** zoope only attends meetings you confirm. Confirmed meetings join automatically at their start time while the page is open.
7. **Summaries:** when a meeting ends, zoope writes a summary on your device: an overview, key points, decisions, action items with owners and due dates, questions waiting on you, and what it said for you. Summaries are saved on the Summaries page, and you can copy them or download them as Markdown.

### Joining real Zoom, Google Meet and Teams calls

zoope uses no platform APIs. The `extension/` folder is a Chrome/Edge extension that drives each platform's own web app:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `extension/`. Setup then shows "Installed".
2. Add a meeting with its link (a `zoom.us/j/…`, `meet.google.com/…` or `teams.microsoft.com/l/meetup-join/…` link) and approve it.
3. At the start time, or when you click **Join now**, the extension opens the link in a new tab. Zoom links go straight to the Zoom web client. It enters your name, turns on the camera and microphone, and clicks Join. If there's a lobby, it waits there.
4. In that tab, the meeting's camera is your live portrait and its microphone is your voice. The avatar is rendered in the meeting tab, and your voice streams from the zoope tab over a local WebRTC link. No server is involved.
5. zoope turns on the meeting's live captions and reads them, with each speaker's name, to decide when to reply. If your neural voice isn't ready, it replies in the meeting chat instead.
6. When the meeting ends, or you click Leave, it leaves the call and writes the summary.

If you host zoope somewhere other than localhost, `*.github.io`, `*.pages.dev`, `*.netlify.app` or `*.vercel.app`, add your site to `bridge.js`'s `matches` in `extension/manifest.json`. After changing `js/portrait.js`, run `extension/build.sh`.

### What zoope says, and what it won't

zoope speaks in the first person as you ("Hi, I'm Alex"). It will not lie about what it is: if someone sincerely asks whether it's a bot or an AI, it says it's your AI avatar speaking from your notes. It shares facts only from your notes, and only when a note clearly matches the question. It never agrees, commits or gives an opinion on your behalf. When it doesn't know something, it says so and passes the question on to you.

### When zoope speaks (`js/engine.js`)

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
- **Voice on phones:** the voice model needs about 1 GB of memory while it loads, more than phone browsers give a tab (the phone resets the page), so zoope makes your voice only on a computer. On a phone you can still scan your voice, and zoope uses the browser voice tuned to it.
- **Voice:** making your voice needs the one-time model download, so the first time needs internet. A zero-shot clone sounds close to you rather than identical, and a quiet room helps. Clone only your own voice, or one you have permission to use.
