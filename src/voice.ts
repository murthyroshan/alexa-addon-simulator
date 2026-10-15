// The device's voice: speech out everywhere, speech in where the browser supports it (Chrome, Edge).

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

const Ctor = () => (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

export const canListen = () => typeof window !== 'undefined' && Boolean(Ctor());

/** Listens for one sentence. `interim` shows the words as they come. */
export function listen(lang: string, interim: (text: string) => void): { done: Promise<string>; stop: () => void } {
  const R = Ctor();
  if (!R) return { done: Promise.resolve(''), stop: () => {} };
  const r = new R();
  r.lang = lang;
  r.interimResults = true;
  r.maxAlternatives = 1;
  let final = '';
  const done = new Promise<string>((resolve) => {
    r.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = text;
      }
      interim(text);
    };
    r.onend = () => resolve(final.trim());
    r.onerror = () => resolve(final.trim());
  });
  r.start();
  return { done, stop: () => r.stop() };
}

/** Says something; calls back when it starts and ends (for the light bar). */
export function speak(text: string, lang: string, started: () => void, ended: () => void) {
  if (!window.speechSynthesis || !text) return ended();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1.03;
  u.onstart = started;
  u.onend = ended;
  u.onerror = ended;
  window.speechSynthesis.speak(u);
}

export const stopSpeaking = () => window.speechSynthesis?.cancel();
