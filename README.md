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

The face, segmentation, 3D and voice runtimes are bundled in `vendor/`. The only thing fetched from outside is the voice model's weights, once, when you make your voice.

1. **Link** the Zoom, Google Meet or Microsoft Teams accounts you use. zoope saves them; it doesn't sign in.
2. **Names:** zoope asks for your full name, the names and nicknames people call you, and which one to introduce itself with.
3. **Head scan → 3D model (four steps):**
   1. **Face and hair:** the bundled MediaPipe Face Landmarker finds 478 points on your face, with depth, and a person-part segmenter (hair, face skin, clothes…) measures your hair colour, crown height and head width.
   2. **Right side** and 3. **left side:** you turn your head about 90°. zoope checks which way you turned, rejects the wrong side, and measures your head depth from the outline.
   4. **Back of head:** you turn around. zoope checks it can't see your face.

   A countdown with beeps lets you follow along without looking at the screen. `js/avatar3d.js` sizes the skull from those measurements, then blends the four photos onto the head in a shader, weighting each by how directly it saw that spot. It renders with WebGL (three.js), blinks, lip-syncs, and turns all the way around once every view is captured. **Download .glb** exports the model, with the blend baked into colours.
4. **Voice (two steps):**
   1. **Scan your voice:** read a passage for 15 seconds. zoope measures your typical pitch, pitch range, speaking pace and brightness (timbre), and plots your pitch contour.
   2. **Make your voice:** Kyutai's Pocket TTS, a 100M-parameter neural TTS model with zero-shot voice cloning, encodes that recording and then generates every sentence in your voice. It runs in the browser through onnxruntime-web in a Web Worker, and nothing is uploaded. The weights (~216 MB) download once from Hugging Face and are cached; see `vendor/README.md` to self-host them. If the model can't load, zoope falls back to the browser's voice tuned to your measured pitch and pace, and tells you that it is not your voice.
5. **Knowledge:** you write the facts and updates zoope is allowed to share. It answers questions by finding the closest match in those notes (TF-IDF).
6. **Meetings:** zoope only attends meetings you confirm. Confirmed meetings join automatically at their start time while the page is open.

### What zoope says, and what it won't

zoope never pretends to be you. It introduces itself as your AI assistant. It shares facts only from your notes, quoting them as yours, and only when a note clearly matches the question. It never agrees, commits or gives an opinion on your behalf. When it doesn't know something, it says so and passes the question on to you.

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

- **Meetings:** zoope runs meetings in its own meeting room. It does not sign in to Zoom, Google Meet or Teams or join calls there; linking an account only saves which account you use.
- **Face:** the 3D head is built from four photos, so it's an approximation. The face itself comes from the 478-point mesh, but the skull is a fitted shape textured from the photos, not a dense scan. Hair volume, ears and the seams between photos are approximate, and the result depends on even lighting and staying the same distance from the camera.
- **Voice:** making your voice needs the one-time model download, so the first time needs internet. A zero-shot clone sounds close to you rather than identical, and a quiet room helps. Clone only your own voice, or one you have permission to use.
