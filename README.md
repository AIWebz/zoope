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

The face model and runtime are bundled in `vendor/` (about 27 MB), so nothing is fetched from outside.

1. **Connect** Zoom, Google Meet or Microsoft Teams.
2. **Names:** zoope asks for your full name, the names and nicknames people call you, and which one to introduce itself with.
3. **Face → 3D model:** the bundled MediaPipe Face Landmarker finds 478 points on your face, with depth. `js/avatar3d.js` turns them into a real 3D head:
   - a textured face surface from your photo
   - a skull shell stitched to the face outline and coloured from your hair and skin
   - ears, neck and shoulders, and a mouth interior that opens with the jaw

   It renders with WebGL (three.js), blinks, lip-syncs and moves its head, and you can drag to rotate it. **Download .glb** exports the model. A single front-facing photo can't show the sides or back of the head, so those are modelled, not scanned. Without WebGL, zoope falls back to the animated 2D photo.
4. **Voice clone:**
   - **Neural clone (recommended):** read a passage for 15 seconds. Kyutai's Pocket TTS, a 100M-parameter neural TTS model with zero-shot voice cloning, encodes your voice and then generates every sentence in it. It runs in the browser through onnxruntime-web in a Web Worker, so your audio and text are never uploaded. The model weights (~216 MB) download once from Hugging Face and are cached; see `vendor/README.md` to self-host them.
   - **Alphabet clone (offline):** say A–Z, and zoope stitches your recorded speech sounds together. It's choppier, but works with no download.
   - **Browser voice:** the system voice, tuned to your pitch and pace.
5. **Knowledge:** you write the facts and updates zoope is allowed to share. It answers questions by finding the closest match in those notes (TF-IDF).
6. **Meetings:** zoope only attends meetings you confirm. Confirmed meetings join automatically at their start time while the page is open.

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

- **Face:** the 3D model uses your real face, but it's built from one front photo. The sides and back of the head, hair volume and ears are modelled rather than captured, and turning the head far to the side stretches the cheeks, so rotation is limited.
- **Voice:** the neural clone captures your timbre and accent from a short sample, but like any zero-shot model it's close rather than perfect, and it improves with a clean, quiet recording. It needs a one-time model download, so the first use needs internet. The alphabet clone is fully offline but choppy.
