// Optional pronunciation playback with the device's speech synthesis. Only ever called
// from a tap (never autoplay). Playback is a model, not proof Justin can pronounce it.
export function ttsAvailable() { return 'speechSynthesis' in window; }

export function englishVoices() {
  if (!ttsAvailable()) return [];
  return speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
}

export function speak(text, { voiceURI = '', rate = 0.9 } = {}) {
  if (!ttsAvailable() || !text) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = englishVoices();
  const v = voices.find((x) => x.voiceURI === voiceURI) || voices.find((x) => /en[-_]GB/i.test(x.lang)) || voices[0];
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-GB';
  u.rate = rate;
  speechSynthesis.speak(u);
  return true;
}
