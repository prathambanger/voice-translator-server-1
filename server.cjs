// server.cjs — Production Ready Speech-to-Speech Translator
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const PQueue = require("p-queue");
const fs = require("fs");

const speechsdk = require("azure-cognitiveservices-speech-sdk");

const app = express();
app.use(cors());

// =============================
// Multer Upload Middleware
// =============================
const upload = multer({ storage: multer.memoryStorage() });

// =============================
// Environment Variables
// =============================
const SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION;
const TRANSLATOR_KEY = process.env.AZURE_TRANSLATOR_KEY;
const TRANSLATOR_REGION = process.env.AZURE_TRANSLATOR_REGION;

// =============================
// Concurrency Queue & Synth Pool
// =============================
const queue = new PQueue({ concurrency: 5 }); // max 5 simultaneous translations

// Pre-create synthesizers (voice pooling)
const synthesizerPool = [];
const MAX_SYNTH = 5;

function createSynthesizer() {
  const speechConfig = speechsdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
  speechConfig.speechSynthesisOutputFormat = 5; // Riff16Khz16BitMonoPcm
  return new speechsdk.SpeechSynthesizer(speechConfig);
}

// Populate the pool
for (let i = 0; i < MAX_SYNTH; i++) {
  synthesizerPool.push(createSynthesizer());
}

// Get free synthesizer
function getSynthesizer() {
  return synthesizerPool[Math.floor(Math.random() * synthesizerPool.length)];
}

// =============================
// Translator Helper (Text→Text)
// =============================
async function translateText(text, targetLang) {
  const url = `https://${TRANSLATOR_REGION}.api.cognitive.microsoft.com/translate?api-version=3.0&to=${targetLang}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": TRANSLATOR_KEY,
      "Ocp-Apim-Subscription-Region": TRANSLATOR_REGION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ Text: text }])
  });

  const data = await response.json();
  return data[0].translations[0].text;
}

// =============================
// Main API — /translate
// =============================
app.post("/translate", upload.single("audioFile"), async (req, res) => {
  queue.add(async () => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No audio file uploaded" });
      }

      const targetLang = req.body.targetLang || "en-US";

      // =============================
      // 1. Speech to Text with Auto-Detect Language
      // =============================
      const audioStream = speechsdk.AudioInputStream.createPushStream();
      audioStream.write(req.file.buffer);
      audioStream.close();

      const audioConfig = speechsdk.AudioConfig.fromStreamInput(audioStream);
      const speechConfig = speechsdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = ""; // enable auto-detect

      const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

      const result = await new Promise((resolve) => {
        recognizer.recognizeOnceAsync(resolve);
      });

      recognizer.close();

      if (result.reason !== speechsdk.ResultReason.RecognizedSpeech) {
        return res.status(500).json({ error: "Speech recognition failed" });
      }

      const recognizedText = result.text;

      // =============================
      // 2. Translate Text
      // =============================
      const translatedText = await translateText(recognizedText, targetLang);

      // =============================
      // 3. Text→Speech Synthesis
      // =============================
      const synthesizer = getSynthesizer();

      const audioBuffer = await new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(
          translatedText,
          (speechResult) => {
            if (speechResult.audioData) {
              resolve(speechResult.audioData);
            } else {
              reject("Speech synthesis failed");
            }
          },
          (err) => reject(err)
        );
      });

      // =============================
      // 4. Return Audio Stream
      // =============================
      const outputFile = `/tmp/${uuidv4()}.wav`;
      fs.writeFileSync(outputFile, Buffer.from(audioBuffer));

      const fileData = fs.readFileSync(outputFile);
      fs.unlinkSync(outputFile);

      res.set("Content-Type", "audio/wav");
      res.send(fileData);

    } catch (e) {
      console.error("Translation Error:", e);
      res.status(500).json({ error: e.toString() });
    }
  });
});

// =============================
// Server Start
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Translator server running on port ${PORT}`));
