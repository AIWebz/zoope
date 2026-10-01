export const LANGUAGES = [
    {
        value: "english", label: "English", flag: "🇬🇧", model: "en/", tag: "en", voice: "alba",
        file: "pocket-tts-english.onnx", line: "Hello there.", published: true,
        temperature: 0.2,
    },
    {
        value: "hebrew", label: "Hebrew", flag: "🇮🇱", model: "he/", tag: "he", voice: "omer", rtl: true,
        file: "pocket-tts-english-ipa.onnx", line: "שלום, מה שלומך?", published: true,
        temperature: 0.2,
    },
    {
        value: "spanish", label: "Spanish", flag: "🇪🇸", model: "es/", tag: "es", voice: "lola",
        file: "pocket-tts-spanish.onnx", line: "Hola, ¿qué tal?", published: true,
    },
    {
        value: "french", label: "French", flag: "🇫🇷", model: "fr/", tag: "fr", voice: "estelle",
        file: "pocket-tts-french.onnx", line: "Bonjour, comment ça va ?", published: true,
    },
    {
        value: "german", label: "German", flag: "🇩🇪", model: "de/", tag: "de", voice: "juergen",
        file: "pocket-tts-german.onnx", line: "Hallo, wie geht es dir?", published: true,
    },
    {
        value: "italian", label: "Italian", flag: "🇮🇹", model: "it/", tag: "it", voice: "giovanni",
        file: "pocket-tts-italian.onnx", line: "Ciao, come stai?", published: true,
    },
    {
        value: "portuguese", label: "Portuguese", flag: "🇧🇷", model: "pt/", tag: "pt", voice: "rafael",
        file: "pocket-tts-portuguese.onnx", line: "Olá, tudo bem?", published: true,
    },
];
/** The languages a visitor can actually choose. */
export const AVAILABLE = LANGUAGES.filter((entry) => entry.published);
export const language = (value) => LANGUAGES.find((entry) => entry.value === value) ?? LANGUAGES[0];
