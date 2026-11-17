/**
 * Voice dictation on top of the Web Speech API.
 *
 * There is no server-side speech-to-text here on purpose: the browser already
 * ships one (Chrome / Edge / Safari, with a `webkit` prefix on Safari), so the
 * phone can dictate without uploading audio through the hub. Firefox has no
 * implementation, which the composer surfaces instead of pretending to listen.
 */

interface VoiceAlternativeLike {
  transcript: string;
}

interface VoiceResultLike {
  isFinal: boolean;
  [index: number]: VoiceAlternativeLike | undefined;
}

interface VoiceResultListLike {
  length: number;
  [index: number]: VoiceResultLike | undefined;
}

export interface VoiceResultEventLike {
  resultIndex: number;
  results: VoiceResultListLike;
}

export interface VoiceErrorEventLike {
  error: string;
}

export interface VoiceRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: VoiceResultEventLike) => void) | null;
  onerror: ((event: VoiceErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type VoiceRecognitionCtor = new () => VoiceRecognitionLike;

interface SpeechScope {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
}

export function speechRecognitionCtor(
  scope: unknown = globalThis,
): VoiceRecognitionCtor | null {
  if (!scope || typeof scope !== 'object') return null;
  const candidate = scope as SpeechScope;
  const ctor = candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as VoiceRecognitionCtor) : null;
}

export function speechSupported(scope: unknown = globalThis): boolean {
  return speechRecognitionCtor(scope) !== null;
}

/** Map the dashboard locale onto a BCP-47 tag the recognizer understands. */
export function speechLocale(locale: string): string {
  return locale === 'en' ? 'en-US' : 'zh-CN';
}

/** Latin words need a separator; Chinese characters do not. */
function needsSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function joinSpoken(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return needsSpace(left, right) ? `${left} ${right}` : `${left}${right}`;
}

/**
 * Append dictated words to whatever the composer already holds.
 *
 * Whitespace at the end is dropped, but an explicit newline is respected: a
 * user who starts a second line before dictating means it.
 */
export function appendTranscript(existing: string, spoken: string): string {
  const addition = spoken.replace(/\s+/g, ' ').trim();
  if (!addition) return existing;
  if (!existing.trim()) return addition;
  if (existing.endsWith('\n')) return `${existing}${addition}`;
  return joinSpoken(existing.replace(/\s+$/, ''), addition);
}

export interface VoiceCallbacks {
  onStart?: () => void;
  /** Running transcript (final + interim) while the finger is still down. */
  onTranscript: (text: string, interim: boolean) => void;
  onError: (code: string) => void;
  /** Fired once when recognition ends, carrying the final transcript. */
  onEnd: (finalText: string) => void;
}

export interface VoiceSession {
  stop(): void;
  abort(): void;
}

/**
 * Start one push-to-talk session.
 *
 * Returns `null` when the browser has no recognizer. The caller owns the
 * session and must call `stop()` on release or `abort()` on unmount.
 */
export function startVoiceRecognition(
  locale: string,
  callbacks: VoiceCallbacks,
): VoiceSession | null {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = speechLocale(locale);
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let finished = false;
  let stopping = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  function finish(): void {
    if (finished) return;
    finished = true;
    if (endTimer !== null) {
      clearTimeout(endTimer);
      endTimer = null;
    }
    callbacks.onEnd(finalText.trim());
  }

  recognition.onstart = () => callbacks.onStart?.();

  recognition.onresult = (event) => {
    let interim = '';
    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
      const result = event.results[index];
      if (!result) continue;
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) finalText = joinSpoken(finalText, text.trim());
      else interim = joinSpoken(interim, text.trim());
    }
    callbacks.onTranscript(
      joinSpoken(finalText, interim).trim(),
      interim.length > 0,
    );
  };

  recognition.onerror = (event) => {
    // `aborted` is our own stop(), not a failure worth a toast.
    if (event.error !== 'aborted') callbacks.onError(event.error);
  };

  recognition.onend = finish;

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop() {
      if (stopping || finished) return;
      stopping = true;
      try {
        recognition.stop();
      } catch {
        // The recognizer may already be gone; the timer below still settles.
      }
      // Some browsers swallow the final `onend` after stop(); do not leave the
      // composer stuck on 「识别中…」 because of it.
      endTimer = setTimeout(finish, 1_200);
    },
    abort() {
      if (finished) return;
      finished = true;
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      try {
        recognition.abort();
      } catch {
        // Nothing left to abort.
      }
    },
  };
}
