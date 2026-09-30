# zoope

zoope is an AI avatar that goes to your Zoom, Google Meet and Microsoft Teams meetings for you, using your face and voice.

The whole AI engine runs in the browser scripts. It uses no APIs and no servers, and your face and voice stay on your device.

## Run it

The site has five pages, each with its own link: Landing (`#/`), Setup (`#/setup`), Clone (`#/clone`), Demo (`#/demo`) and Meetings (`#/meetings`). A blue curtain wipe plays when you switch pages.

Open `index.html` through any static server, for example `python3 -m http.server`. Then go to http://localhost:8000. The camera and mic only work on `localhost` or over HTTPS.

## How it works

The face model and runtime are bundled in `vendor/` (about 27 MB), so nothing is fetched from outside.

1. **Connect** Zoom, Google Meet or Microsoft Teams.
2. **Names:** zoope asks for your full name, the names and nicknames people call you, and which one to introduce itself with.
3. **Face clone:** the bundled MediaPipe Face Landmarker finds 478 points on your face. zoope splits your real photo into a triangle mesh and warps it live: the jaw drops and lips part as it talks, and the eyelids close to blink. If the photo shows your teeth, the real teeth part too; otherwise teeth and tongue are drawn in. If the model can't load, zoope falls back to a cartoon avatar (`js/facemesh.js`).
4. **Voice clone:** you say the alphabet one letter at a time. Every letter name holds English speech sounds ("B" = b + ee, "F" = eh + f, "Y" = w + eye…). zoope cuts your recordings into about 27 sound units. To speak, it turns text into sounds using pronunciation rules and joins your own units with pitch smoothing, intonation and crossfades (`js/voiceclone.js`). You can switch meetings to a smooth browser voice tuned to the pitch and pace from a 6-second sentence recording.
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

- **Face:** the avatar is your real photo, animated. It looks close to you but not perfect. Big head turns, strong expressions, and the inside of the mouth when the photo shows it closed are approximated.
- **Voice:** the cloned voice is built from your own recorded sounds, so it has your tone. It still sounds choppy and robotic, because the alphabet doesn't cover every English sound (for example "th", short "i", "h" and "ng"), so those are replaced with the closest sounds. Smooth, natural cloning needs a trained neural model, which can't run inside a web page without a server or API.
