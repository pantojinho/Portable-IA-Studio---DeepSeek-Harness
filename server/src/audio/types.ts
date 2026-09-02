/**
 * CONTRACT — audio (voices, TTS, STT, meetings, music). Tasks AUD-01…AUD-10.
 */
export interface Voice {
  id: string;                        // stable slug: "piper-pt_BR-faber", "kokoro-pf_dora", "clone-gabriel"
  name: string;
  engine: "piper" | "kokoro" | "outetts" | "chatterbox" | "xtts" | "f5tts" | (string & {});
  language: string;                  // BCP-47: "pt-BR"
  gender?: "f" | "m" | "n";
  /** model files (registry ids) this voice needs */
  models: string[];
  /** reference sample for cloning engines (voices/<id>/sample.wav) */
  sample?: string;
  /** engine-specific: speaker id, speed, temperature… */
  params?: Record<string, unknown>;
  builtin: boolean;
  createdAt: string;
}

export interface TtsRequest {
  text: string;
  voice: string;                     // Voice.id
  format?: "wav" | "mp3" | "ogg";
  speed?: number;
  /** stream chunks as they are produced (SSE / chunked audio) */
  stream?: boolean;
}

export interface SttRequest {
  /** path to an audio/video file under data/ or an uploaded temp file */
  file: string;
  language?: string | "auto";
  model?: string;                    // registry id, default = configured whisper
  timestamps?: "none" | "segment" | "word";
  diarize?: boolean;
  translateToEnglish?: boolean;
}

export interface TranscriptWord { word: string; start: number; end: number }
export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string; confidence?: number; words?: TranscriptWord[] }
export interface Transcript { language: string; duration: number; segments: TranscriptSegment[]; text: string }

export interface Meeting {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  status: "recording" | "transcribing" | "summarizing" | "done" | "failed";
  audioPath?: string;                // data/recordings/<id>.wav
  transcript?: Transcript;
  summary?: { summary: string; decisions: string[]; actions: { text: string; owner?: string; due?: string }[]; questions: string[] };
  projectId?: string;                // auto-ingest target (DOC-02)
  sources: ("mic" | "system")[];
}

export interface MusicRequest {
  prompt: string;
  lyrics?: string;
  durationSec?: number;
  engine?: "acestep" | "musicgen" | "stableaudio";
  seed?: number;
}
