/**
 * Recording a voice prompt from the microphone.
 *
 * Cloning wants a few clean seconds, so this is deliberately plain: start,
 * watch the level, stop, hand back the audio. The recording is decoded in the
 * page and never leaves it.
 */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];
function pickMimeType() {
    for (const candidate of MIME_CANDIDATES) {
        if (candidate === "" || MediaRecorder.isTypeSupported(candidate))
            return candidate;
    }
    return "";
}
export class Recorder {
    recorder = null;
    stream = null;
    context = null;
    analyser = null;
    chunks = [];
    startedAt = 0;
    get recording() {
        return this.recorder?.state === "recording";
    }
    get seconds() {
        return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
    }
    /** Peak level of the last analysis window, 0 to 1, for the meter. */
    get level() {
        if (!this.analyser)
            return 0;
        const samples = new Float32Array(this.analyser.fftSize);
        this.analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples)
            peak = Math.max(peak, Math.abs(sample));
        return Math.min(1, peak * 1.6);
    }
    async start() {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        this.stream = stream;
        // A separate context just for the meter: the recorder writes the file.
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        this.context = context;
        this.analyser = analyser;
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        this.chunks = [];
        recorder.ondataavailable = (event) => {
            if (event.data.size)
                this.chunks.push(event.data);
        };
        recorder.start(250);
        this.recorder = recorder;
        this.startedAt = performance.now();
    }
    async stop() {
        const recorder = this.recorder;
        if (!recorder)
            throw new Error("not recording");
        const seconds = this.seconds;
        const finished = new Promise((resolve) => {
            recorder.onstop = () => resolve();
        });
        recorder.stop();
        await finished;
        this.release();
        return { blob: new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }), seconds };
    }
    /** Give the microphone back, whether or not a recording was kept. */
    release() {
        this.stream?.getTracks().forEach((track) => track.stop());
        void this.context?.close();
        this.recorder = null;
        this.stream = null;
        this.context = null;
        this.analyser = null;
        this.startedAt = 0;
    }
}
